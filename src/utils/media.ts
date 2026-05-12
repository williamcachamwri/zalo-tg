import axios from 'axios';
import { createWriteStream, mkdirSync, copyFileSync } from 'fs';
import { stat, unlink } from 'fs/promises';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import os from 'os';

// Resolve scripts/ dir relative to this source file (works with tsx and after tsc build)
const SCRIPTS_DIR = path.resolve(
  new URL(import.meta.url).pathname,
  '../../scripts',
);

const TMP_DIR = path.join(os.tmpdir(), 'zalo-tg');

/** Download a remote URL to a temp file. Returns the local file path.
 *  When using a local Telegram Bot API server (--local flag), getFileLink()
 *  returns a file:// URL pointing to the server's working directory.
 *  In that case we copy the file directly instead of downloading via HTTP.
 */
export async function downloadToTemp(url: string, fileName?: string, retries = 3): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });

  // Local Bot API server returns file:// paths — copy directly, no HTTP needed
  if (url.startsWith('file:')) {
    const srcPath = fileURLToPath(url);
    const baseName = (fileName ?? path.basename(srcPath))
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 128);
    const destPath = path.join(TMP_DIR, `${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${baseName}`);
    copyFileSync(srcPath, destPath);
    // Delete the original from local server's data dir — it's been delivered, no longer needed
    await unlink(srcPath).catch(() => undefined);
    return destPath;
  }

  // Sanitize filename and add a unique prefix so concurrent downloads
  // with the same logical name (e.g. multiple 'photo.jpg' in a media group)
  // do not overwrite each other.
  const baseName = (fileName ?? `download_${Date.now()}`)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 128);

  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 500ms, 1500ms, ...
      await new Promise(r => setTimeout(r, 500 * attempt * attempt));
    }

    const filePath = path.join(TMP_DIR, `${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${baseName}`);
    try {
      const resp = await axios.get<NodeJS.ReadableStream>(url, {
        responseType: 'stream',
        timeout: 30_000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZaloTGBridge/1.0)' },
      });

      await new Promise<void>((resolve, reject) => {
        const writer = createWriteStream(filePath);
        resp.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      const { size } = await stat(filePath);
      if (size === 0) {
        await unlink(filePath).catch(() => undefined);
        lastErr = new Error(`Downloaded file is empty: ${url}`);
        continue;
      }

      return filePath;
    } catch (err) {
      await unlink(filePath).catch(() => undefined);
      lastErr = err;
    }
  }

  throw lastErr;
}

/** Remove a temp file, ignoring errors. */
export async function cleanTemp(filePath: string): Promise<void> {
  try { await unlink(filePath); } catch { /* ignore */ }
}

/**
 * Convert an audio file to M4A (AAC) using ffmpeg.
 * Returns the path to the converted file (caller must clean it up).
 */
export async function convertToM4a(inputPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const outputPath = path.join(TMP_DIR, `voice_${Date.now()}.m4a`);
  await new Promise<void>((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-i', inputPath,
      '-c:a', 'aac', '-b:a', '64k', '-ar', '44100',
      '-vn', outputPath,
    ]);
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
    ff.on('error', reject);
  });
  return outputPath;
}

/**
 * Convert a WebM video (e.g. Telegram video sticker) to GIF using ffmpeg.
 * Returns the path to the output GIF (caller must clean it up).
 */
export async function convertWebmToGif(inputPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const outputPath = path.join(TMP_DIR, `sticker_${Date.now()}.gif`);
  // Two-pass palette for better quality; scale to max 256px wide
  const palettePass = path.join(TMP_DIR, `palette_${Date.now()}.png`);
  await new Promise<void>((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-i', inputPath,
      '-vf', 'fps=15,scale=min(256\\,iw):-2:flags=lanczos,palettegen=stats_mode=diff',
      palettePass,
    ]);
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg palettegen exit ${code}`)));
    ff.on('error', reject);
  });
  await new Promise<void>((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-i', inputPath, '-i', palettePass,
      '-lavfi', 'fps=15,scale=min(256\\,iw):-2:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5',
      outputPath,
    ]);
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg paletteuse exit ${code}`)));
    ff.on('error', reject);
  });
  await unlink(palettePass).catch(() => undefined);
  return outputPath;
}

/**
 * Convert a Telegram animated sticker (.tgs / Lottie+gzip) to GIF.
 * Requires: Python 3 + lottie + cairosvg packages in PYTHON_PATH env var
 * (defaults to "python3"). On macOS homebrew, DYLD_LIBRARY_PATH must point
 * to /opt/homebrew/lib so cairocffi can find libcairo.2.dylib.
 * Returns the path to the output GIF (caller must clean it up).
 */
export async function convertTgsToGif(inputPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const outputPath = path.join(TMP_DIR, `sticker_tgs_${Date.now()}.gif`);
  const scriptPath = path.join(SCRIPTS_DIR, 'tgs_to_gif.py');
  const pythonBin  = process.env.PYTHON_PATH ?? 'python3';

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(pythonBin, [scriptPath, inputPath, outputPath], {
      env: {
        ...process.env,
        // macOS: help cairocffi find libcairo installed via Homebrew
        DYLD_LIBRARY_PATH: [
          '/opt/homebrew/lib',
          process.env.DYLD_LIBRARY_PATH ?? '',
        ].filter(Boolean).join(':'),
      },
    });
    const stderr: string[] = [];
    proc.stderr.on('data', (d: Buffer) => stderr.push(d.toString()));
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`tgs_to_gif.py exit ${code}: ${stderr.join('')}`));
    });
    proc.on('error', reject);
  });

  return outputPath;
}

/**
 * Extract the first frame of a video as a JPEG thumbnail.
 * Returns the path to the thumbnail file (caller must clean it up).
 */
export async function extractVideoThumbnail(videoPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const outputPath = path.join(TMP_DIR, `thumb_${Date.now()}.jpg`);
  await new Promise<void>((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-i', videoPath,
      '-vframes', '1',
      '-q:v', '5',    // quality 1-31, lower=better; 5 is ~90% JPEG
      '-vf', 'scale=\'min(720,iw)\':-2',  // max 720px wide, keep aspect
      outputPath,
    ]);
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg thumb exit ${code}`)));
    ff.on('error', reject);
  });
  return outputPath;
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv']);

/** Guess media type from filename or URL. */
export function detectMediaType(fileNameOrUrl: string): 'image' | 'video' | 'document' {
  const lower = fileNameOrUrl.toLowerCase();
  const ext   = path.extname(lower.split('?')[0] ?? '');
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (/\.(jpg|jpeg|png|gif|webp)(\?|$)/.test(lower)) return 'image';
  if (/\.(mp4|mov|avi|mkv|webm)(\?|$)/.test(lower))  return 'video';
  return 'document';
}
