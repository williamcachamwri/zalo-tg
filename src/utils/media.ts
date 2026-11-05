import axios from 'axios';
import { createWriteStream, mkdirSync, copyFileSync } from 'fs';
import { readFile, stat, unlink, writeFile } from 'fs/promises';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { gunzipSync } from 'zlib';
import path from 'path';
import { imageSizeFromFile } from 'image-size/fromFile';
import { createSharedTempPath, getSharedTempDir } from './sharedTemp.js';

// Local Bot API reads outgoing files from a shared host/container path.
// Use a permission-safe resolver instead of the historical fixed /tmp/zalo-tg
// directory, which can be left root-owned on Docker bind mounts.
const TMP_DIR = getSharedTempDir('zalo-tg');

function uniqueTempName(prefix: string, extension: string): string {
  return createSharedTempPath('zalo-tg', prefix, extension);
}

/** Keep readable Unicode filenames, but remove path/control chars unsafe on disk. */
export function sanitizeFileName(fileName: string, fallback = `download_${Date.now()}`): string {
  const cleaned = fileName
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/^\.+$/, '_')
    .trim()
    .slice(0, 180);
  return cleaned || fallback;
}

/** Download a remote URL to a temp file. Returns the local file path.
 *  When using a local Telegram Bot API server (--local flag), getFileLink()
 *  returns a file:// URL pointing to the server's working directory.
 *  In that case we copy the file directly instead of downloading via HTTP.
 */
export async function downloadToTemp(url: string, fileName?: string, retries = 3): Promise<string> {
  if (!Number.isInteger(retries) || retries < 1) {
    throw new Error('retries must be an integer >= 1');
  }
  mkdirSync(TMP_DIR, { recursive: true });

  // Local Bot API server returns file:// paths — copy directly, no HTTP needed
  if (url.startsWith('file:')) {
    const srcPath = fileURLToPath(url);
    const baseName = sanitizeFileName(fileName ?? path.basename(srcPath));
    const destPath = path.join(TMP_DIR, `${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${baseName}`);
    try {
      copyFileSync(srcPath, destPath);
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: unknown }).code)
        : '';
      if (code === 'ENOENT') {
        throw new Error(
          `Local Bot API file is not visible to the bridge: ${srcPath}. `
          + 'Mount TELEGRAM_WORK_DIR at the same absolute path in both processes.',
          { cause: err },
        );
      }
      throw err;
    }
    // The source belongs to telegram-bot-api's cache. Never delete it here;
    // cleanTemp() only removes the bridge-owned destination copy.
    return destPath;
  }

  // Sanitize filename and add a unique prefix so concurrent downloads
  // with the same logical name (e.g. multiple 'photo.jpg' in a media group)
  // do not overwrite each other.
  const baseName = sanitizeFileName(fileName ?? `download_${Date.now()}`);

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
        timeout: 15_000, // 15 s per attempt; downloadToTemp retries 3x on failure,
                         // so total wait is bounded to roughly 15s×3 + backoff
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZaloTGBridge/1.0)' },
        // Force IPv4-only DNS resolution/connect. Node's Happy Eyeballs
        // (RFC 8305, default since Node 18) tries IPv6 candidates first; in
        // many Docker setups the container has no working IPv6 route, so
        // every request stalls through the full IPv6 connect-attempt timeout
        // before falling back to IPv4 — surfacing as
        // `AggregateError [ETIMEDOUT]` at `internalConnectMultiple`. Zalo's
        // CDN (zdn.vn / dlfl.vn / flchat.vn) is IPv4-only in practice, so
        // skipping the IPv6 attempt entirely removes this stall.
        family: 4,
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

/**
 * Download the first working URL in priority order.
 *
 * Zalo photo messages can carry an HD URL, a normal URL and a thumbnail. The
 * CDN does not always keep those variants alive for the same amount of time,
 * so a dead HD URL must not make the whole message disappear.
 */
export async function downloadToTempFromCandidates(
  urls: readonly string[],
  fileName?: string,
  retries = 3,
): Promise<string> {
  const candidates = Array.from(new Set(urls.map(url => url.trim()).filter(Boolean)));
  if (candidates.length === 0) throw new Error('No media URL candidates were provided');

  const errors: unknown[] = [];
  for (const url of candidates) {
    try {
      return await downloadToTemp(url, fileName, retries);
    } catch (err) {
      errors.push(err);
    }
  }

  throw new AggregateError(errors, `Failed to download media from ${candidates.length} URL candidate(s)`);
}

/** Remove a temp file, ignoring errors. */
export async function cleanTemp(filePath: string): Promise<void> {
  try { await unlink(filePath); } catch { /* ignore */ }
}

/**
 * Run an array of async tasks with a bounded concurrency limit.
 *
 * Firing all tasks at once (Promise.allSettled(tasks.map(...))) saturates the
 * OS TCP connection pool when the array is large (e.g. an 18-photo album),
 * causing ETIMEDOUT on later requests even though the server is reachable.
 *
 * Returns the same shape as Promise.allSettled so callers can skip
 * individual failed items without aborting the whole batch.
 */
export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency = 4,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const idx = next++;
      try {
        results[idx] = { status: 'fulfilled', value: await tasks[idx]!() };
      } catch (err) {
        results[idx] = { status: 'rejected', reason: err };
      }
    }
  }

  // Launch `concurrency` parallel workers; each pulls the next task until done
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

/** Split Telegram album payloads without ever producing an invalid >10 batch. */
export function telegramMediaBatches<T>(items: T[], maxBatchSize = 10): T[][] {
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 2) {
    throw new Error('maxBatchSize must be an integer >= 2');
  }
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += maxBatchSize) {
    batches.push(items.slice(i, i + maxBatchSize));
  }
  return batches;
}

export interface SpriteSheetLayout {
  frames: number;
  frameWidth: number;
  frameHeight: number;
  direction: 'horizontal' | 'vertical';
}

/** Resolve equally sized frames from a Zalo sticker sprite sheet. */
export function getSpriteSheetLayout(
  width: number,
  height: number,
  declaredFrames = 0,
): SpriteSheetLayout {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('Sprite dimensions must be positive integers');
  }

  const requested = Number.isInteger(declaredFrames) && declaredFrames > 1
    ? declaredFrames
    : 0;
  if (requested > 1 && width % requested === 0) {
    return { frames: requested, frameWidth: width / requested, frameHeight: height, direction: 'horizontal' };
  }
  if (requested > 1 && height % requested === 0) {
    return { frames: requested, frameWidth: width, frameHeight: height / requested, direction: 'vertical' };
  }

  // Zalo currently serves square frames in one horizontal strip. Keep a
  // vertical inference as a defensive fallback for older sticker packs.
  if (width > height && width % height === 0) {
    return { frames: width / height, frameWidth: height, frameHeight: height, direction: 'horizontal' };
  }
  if (height > width && height % width === 0) {
    return { frames: height / width, frameWidth: width, frameHeight: width, direction: 'vertical' };
  }
  return { frames: 1, frameWidth: width, frameHeight: height, direction: 'horizontal' };
}

/** Convert a Zalo PNG/WebP sprite strip into a Telegram-compatible GIF. */
export async function convertSpriteSheetToGif(
  inputPath: string,
  declaredFrames: number,
  frameDurationMs: number,
): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const dimensions = await imageSizeFromFile(inputPath);
  if (!dimensions.width || !dimensions.height) throw new Error('Cannot read sticker sprite dimensions');
  const layout = getSpriteSheetLayout(dimensions.width, dimensions.height, declaredFrames);
  if (layout.frames < 2) throw new Error('Sticker sprite does not contain multiple frames');

  const duration = Number.isFinite(frameDurationMs)
    ? Math.min(1_000, Math.max(20, frameDurationMs))
    : 100;
  const frameRate = (1_000 / duration).toFixed(6);
  const position = layout.direction === 'horizontal'
    ? `x='mod(n\\,${layout.frames})*${layout.frameWidth}':y=0`
    : `x=0:y='mod(n\\,${layout.frames})*${layout.frameHeight}'`;
  const crop = `crop=${layout.frameWidth}:${layout.frameHeight}:${position},format=rgba`;
  const outputPath = uniqueTempName('zalo_sticker', '.gif');

  await new Promise<void>((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-loop', '1',
      '-framerate', frameRate,
      '-i', inputPath,
      '-vf', crop,
      '-frames:v', String(layout.frames),
      '-loop', '0',
      outputPath,
    ]);
    let stderr = '';
    ff.stderr?.on('data', chunk => { stderr += String(chunk).slice(-2_000); });
    ff.on('close', code => code === 0
      ? resolve()
      : reject(new Error(`ffmpeg sprite conversion exit ${code}: ${stderr.trim().slice(-500)}`)));
    ff.on('error', reject);
  });
  return outputPath;
}

/**
 * Convert an audio file to M4A (AAC) using ffmpeg.
 * Returns the path to the converted file (caller must clean it up).
 */
export async function convertToM4a(inputPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const outputPath = uniqueTempName('voice', '.m4a');
  await new Promise<void>((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-i', inputPath,
      // Keep an iOS/Android-friendly AAC-LC profile and put moov atom first.
      // Some mobile clients show "--:--" or fail playback if metadata is tail-loaded.
      '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '64k', '-ac', '1', '-ar', '44100',
      '-movflags', '+faststart',
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
  const outputPath = uniqueTempName('sticker', '.gif');
  // Two-pass palette preserves the original frame rate, Telegram's full
  // 512px sticker resolution and transparent pixels.
  const palettePass = uniqueTempName('palette', '.png');
  try {
    await new Promise<void>((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-y', '-i', inputPath,
        '-vf', 'scale=min(512\\,iw):-2:flags=lanczos,format=rgba,palettegen=stats_mode=diff:reserve_transparent=1',
        palettePass,
      ]);
      ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg palettegen exit ${code}`)));
      ff.on('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-y', '-i', inputPath, '-i', palettePass,
        '-lavfi', 'scale=min(512\\,iw):-2:flags=lanczos,format=rgba[x];[x][1:v]paletteuse=dither=sierra2_4a:alpha_threshold=128',
        outputPath,
      ]);
      ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg paletteuse exit ${code}`)));
      ff.on('error', reject);
    });
  } finally {
    await unlink(palettePass).catch(() => undefined);
  }
  return outputPath;
}

/** Convert a Telegram static WebP sticker to a lossless transparent PNG. */
export async function convertStickerToPng(inputPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(inputPath);
  if (!image.width || !image.height) throw new Error('Cannot read static sticker dimensions');
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, image.width, image.height);
  ctx.drawImage(image, 0, 0, image.width, image.height);
  const outputPath = uniqueTempName('telegram_sticker', '.png');
  await writeFile(outputPath, canvas.toBuffer('image/png'));
  return outputPath;
}

/** Render Telegram's gzip-compressed Lottie/TGS sticker to a transparent GIF. */
export async function convertTgsToGif(inputPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const compressed = await readFile(inputPath);
  let animationData: Buffer;
  try {
    animationData = gunzipSync(compressed);
  } catch {
    // Accept plain Lottie JSON too, which makes the converter easier to test
    // and supports clients that already decompressed the TGS payload.
    animationData = compressed;
  }

  const { createCanvas, GifDisposal, GifEncoder, LottieAnimation } = await import('@napi-rs/canvas');
  const animation = LottieAnimation.loadFromData(animationData);
  const sourceWidth = Math.round(animation.width);
  const sourceHeight = Math.round(animation.height);
  const sourceFrames = Math.max(1, Math.round(animation.frames));
  const sourceFps = Number.isFinite(animation.fps) && animation.fps > 0 ? animation.fps : 30;
  if (sourceWidth < 1 || sourceHeight < 1) throw new Error('TGS animation has invalid dimensions');
  if (sourceFrames > 600) throw new Error(`TGS animation has too many frames: ${sourceFrames}`);

  const sourceCanvas = createCanvas(sourceWidth, sourceHeight);
  const sourceCtx = sourceCanvas.getContext('2d');

  // Zalo's GIF flow uploads the whole file as the thumbnail and rejects
  // anything over 10 MB. Shrink and subsample so busy stickers stay under it.
  const sizeLimit = 9_500_000;
  const profiles = [
    { maxSide: 512, fps: 30, maxFrames: 180 },
    { maxSide: 448, fps: 24, maxFrames: 150 },
    { maxSide: 384, fps: 20, maxFrames: 120 },
    { maxSide: 320, fps: 16, maxFrames: 100 },
    { maxSide: 256, fps: 12, maxFrames: 80 },
    { maxSide: 192, fps: 10, maxFrames: 60 },
  ];

  for (const [index, profile] of profiles.entries()) {
    const scale = Math.min(1, profile.maxSide / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    let step = Math.max(1, Math.round(sourceFps / profile.fps));
    if (Math.ceil(sourceFrames / step) > profile.maxFrames) {
      step = Math.ceil(sourceFrames / profile.maxFrames);
    }
    const delay = Math.max(20, Math.round((1_000 * step) / sourceFps));

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const encoder = new GifEncoder(width, height, { repeat: 0, quality: 5 });
    try {
      for (let frame = 0; frame < sourceFrames; frame += step) {
        sourceCtx.clearRect(0, 0, sourceWidth, sourceHeight);
        animation.seekFrame(frame);
        animation.render(sourceCtx);
        // @napi-rs/canvas 1.0.x returns all-zero pixels from getImageData()
        // after LottieAnimation.render() on the same canvas; drawing it into a
        // second canvas first makes the rendered pixels readable.
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(sourceCanvas, 0, 0, width, height);
        const rgba = ctx.getImageData(0, 0, width, height).data;
        encoder.addFrame(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height, {
          delay,
          disposal: GifDisposal.Background,
        });
      }
      const gif = encoder.finish();
      if (gif.length <= sizeLimit || index === profiles.length - 1) {
        const outputPath = uniqueTempName('telegram_sticker', '.gif');
        await writeFile(outputPath, gif);
        return outputPath;
      }
      console.warn(`[media] TGS GIF ${width}x${height} is ${gif.length} bytes; retrying smaller`);
    } finally {
      encoder.dispose();
    }
  }
  throw new Error('TGS animation could not be encoded under the upload limit');
}

/**
 * Extract the first frame of a video as a JPEG thumbnail.
 * Returns the path to the thumbnail file (caller must clean it up).
 */
export async function extractVideoThumbnail(videoPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const outputPath = uniqueTempName('thumb', '.jpg');
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
  // Query strings and fragments are URL metadata, not part of the filename.
  // Strip both before asking path.extname() so `clip.webm#t=3` is detected.
  const pathname = lower.split(/[?#]/, 1)[0] ?? '';
  const ext = path.extname(pathname);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (/\.(jpg|jpeg|png|gif|webp)(?:[?#]|$)/.test(lower)) return 'image';
  if (/\.(mp4|mov|avi|mkv|webm)(?:[?#]|$)/.test(lower))  return 'video';
  return 'document';
}
