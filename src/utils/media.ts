import axios from 'axios';
import { createWriteStream, mkdirSync, copyFileSync } from 'fs';
import { stat, unlink } from 'fs/promises';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';

const TMP_DIR = path.join(os.tmpdir(), 'zalo-tg');

function makeTempPath(baseName: string): string {
  return path.join(TMP_DIR, `${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${baseName}`);
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
}

/** Download a remote URL to a temp file. Returns the local file path.
 *  When using a local Telegram Bot API server (--local flag), getFileLink()
 *  returns a file:// URL — the file is copied from server dir to temp.
 *  Use withTempDownload() to auto-cleanup both copy and source on completion.
 */
export async function downloadToTemp(url: string, fileName?: string, retries = 3): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });

  // Local Bot API server returns file:// paths — copy directly, no HTTP needed
  if (url.startsWith('file:')) {
    const srcPath = fileURLToPath(url);
    const baseName = sanitizeName(fileName ?? path.basename(srcPath));
    const destPath = makeTempPath(baseName);
    copyFileSync(srcPath, destPath);
    return destPath;
  }

  const baseName = sanitizeName(fileName ?? `download_${Date.now()}`);
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 500 * attempt * attempt));

    const filePath = makeTempPath(baseName);
    try {
      const resp = await axios.get<NodeJS.ReadableStream>(url, {
        responseType: 'stream',
        timeout: 120_000,
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
  await unlink(filePath).catch(() => {});
}

/**
 * Download/copy a URL to a temp file, run fn(localPath), then clean up.
 * For file:// URLs (local Telegram Bot API server), also deletes the source
 * file from the server's working directory after use.
 * Guarantees cleanup even if fn throws.
 */
export async function withTempDownload<T>(
  url: string,
  fileName: string | undefined,
  fn: (localPath: string) => Promise<T>,
): Promise<T> {
  const localPath = await downloadToTemp(url, fileName);
  try {
    return await fn(localPath);
  } finally {
    await unlink(localPath).catch(() => {});
    // For local server file:// URLs, also remove source from server's data dir
    if (url.startsWith('file:')) {
      await unlink(fileURLToPath(url)).catch(() => {});
    }
  }
}

/**
 * Same as withTempDownload but for multiple URLs in parallel.
 * All temp files (and file:// sources) are cleaned up after fn returns.
 */
export async function withTempDownloads<T>(
  items: Array<{ url: string; fileName?: string }>,
  fn: (localPaths: string[]) => Promise<T>,
): Promise<T> {
  mkdirSync(TMP_DIR, { recursive: true });
  const localPaths = await Promise.all(items.map(i => downloadToTemp(i.url, i.fileName)));
  try {
    return await fn(localPaths);
  } finally {
    await Promise.all(localPaths.map(p => unlink(p).catch(() => {})));
    // Clean file:// sources
    await Promise.all(
      items
        .filter(i => i.url.startsWith('file:'))
        .map(i => unlink(fileURLToPath(i.url)).catch(() => {})),
    );
  }
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
