import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

process.env.TG_TOKEN ||= 'test-token';
process.env.TG_GROUP_ID ||= '-1001';
process.env.DATA_DIR ||= path.join(os.tmpdir(), `zalo-tg-media-test-${process.pid}`);

const {
  cleanTemp,
  convertTgsToGif,
  detectMediaType,
  downloadToTemp,
  downloadToTempFromCandidates,
  getSpriteSheetLayout,
  sanitizeFileName,
  telegramMediaBatches,
} = await import('../src/utils/media.js');

test('sanitizeFileName keeps Unicode while replacing unsafe characters', () => {
  assert.equal(sanitizeFileName('Hồ sơ/2026:"x"?.pdf'), 'Hồ sơ_2026__x__.pdf');
});

test('sanitizeFileName replaces dot-only and blank names with safe values', () => {
  assert.equal(sanitizeFileName('...'), '_');
  assert.equal(sanitizeFileName('   ', 'fallback.bin'), 'fallback.bin');
});

test('sanitizeFileName enforces a bounded filename length', () => {
  assert.equal(sanitizeFileName('a'.repeat(500)).length, 180);
});

test('telegramMediaBatches handles empty, exact and trailing-single batches', () => {
  assert.deepEqual(telegramMediaBatches([]), []);
  assert.deepEqual(telegramMediaBatches([1, 2], 2), [[1, 2]]);
  assert.deepEqual(telegramMediaBatches([1, 2, 3], 2), [[1, 2], [3]]);
});

test('telegramMediaBatches rejects invalid Telegram album sizes', () => {
  assert.throws(() => telegramMediaBatches([1], 1), /integer >= 2/);
  assert.throws(() => telegramMediaBatches([1], 2.5), /integer >= 2/);
});

test('getSpriteSheetLayout resolves Zalo horizontal strips and defensive vertical strips', () => {
  assert.deepEqual(getSpriteSheetLayout(650, 130, 5), {
    frames: 5,
    frameWidth: 130,
    frameHeight: 130,
    direction: 'horizontal',
  });
  assert.deepEqual(getSpriteSheetLayout(130, 520, 4), {
    frames: 4,
    frameWidth: 130,
    frameHeight: 130,
    direction: 'vertical',
  });
  assert.deepEqual(getSpriteSheetLayout(390, 130, 0).frames, 3);
  assert.deepEqual(getSpriteSheetLayout(130, 130, 0).frames, 1);
});

test('detectMediaType handles case, query strings and unknown extensions', () => {
  assert.equal(detectMediaType('PHOTO.JPG?token=1'), 'image');
  assert.equal(detectMediaType('clip.WebM#x'), 'video');
  assert.equal(detectMediaType('archive.zip'), 'document');
  assert.equal(detectMediaType('https://x/y.png?download=.bin'), 'image');
});

test('downloadToTemp copies file URLs into bridge-owned storage', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zalo-tg-file-url-'));
  const src = path.join(dir, 'nguồn.txt');
  await writeFile(src, 'payload', 'utf8');
  const copied = await downloadToTemp(pathToFileURL(src).toString(), '../unsafe?.txt');
  assert.equal(await readFile(copied, 'utf8'), 'payload');
  assert.notEqual(copied, src);
  assert.equal(path.basename(copied).includes('/'), false);
  await cleanTemp(copied);
});

test('downloadToTemp explains an unshared Local Bot API file path', async () => {
  const missing = pathToFileURL(path.join(os.tmpdir(), `missing-local-bot-${process.pid}.webm`)).toString();
  await assert.rejects(
    () => downloadToTemp(missing, 'sticker.webm'),
    /Local Bot API file is not visible.*same absolute path/,
  );
});

test('convertTgsToGif renders every Lottie frame into a transparent GIF', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zalo-tg-tgs-'));
  const tgsPath = path.join(dir, 'sticker.tgs');
  const lottie = {
    v: '5.7.4', fr: 10, ip: 0, op: 2, w: 32, h: 32, nm: 'test', ddd: 0, assets: [],
    layers: [{
      ddd: 0, ind: 1, ty: 4, nm: 'dot', sr: 1,
      ks: {
        o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [16, 16, 0] },
        a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] },
      },
      shapes: [{
        ty: 'gr', nm: 'ellipse',
        it: [
          { d: 1, ty: 'el', s: { a: 0, k: [20, 20] }, p: { a: 0, k: [0, 0] } },
          { ty: 'fl', c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 }, r: 1 },
          { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 }, sk: { a: 0, k: 0 }, sa: { a: 0, k: 0 } },
        ],
      }],
      ip: 0, op: 2, st: 0, bm: 0,
    }],
  };
  await writeFile(tgsPath, gzipSync(JSON.stringify(lottie)));
  const gifPath = await convertTgsToGif(tgsPath);
  const gif = await readFile(gifPath);
  assert.equal(gif.subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.deepEqual(await import('image-size/fromFile').then(m => m.imageSizeFromFile(gifPath)), {
    height: 32,
    width: 32,
    type: 'gif',
  });
  await cleanTemp(gifPath);
});

test('downloadToTemp rejects nonsensical retry counts before I/O', async () => {
  await assert.rejects(() => downloadToTemp('https://invalid.example/file', 'x', 0), /retries must be/);
  await assert.rejects(() => downloadToTemp('https://invalid.example/file', 'x', 1.5), /retries must be/);
});

test('downloadToTempFromCandidates falls back when the preferred URL is unavailable', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zalo-tg-media-fallback-'));
  const missing = pathToFileURL(path.join(dir, 'missing.jpg')).toString();
  const fallback = path.join(dir, 'fallback.jpg');
  await writeFile(fallback, 'fallback-image', 'utf8');

  const downloaded = await downloadToTempFromCandidates(
    [missing, pathToFileURL(fallback).toString(), pathToFileURL(fallback).toString()],
    'photo.jpg',
  );
  assert.equal(await readFile(downloaded, 'utf8'), 'fallback-image');
  await cleanTemp(downloaded);
});

test('cleanTemp is idempotent for missing paths', async () => {
  await cleanTemp(path.join(os.tmpdir(), `missing-${process.pid}-${Date.now()}`));
});

test('downloadToTemp handles file URLs with Docker hostname from local Bot API', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zalo-tg-docker-host-'));
  const src = path.join(dir, 'test.txt');
  await writeFile(src, 'docker-payload', 'utf8');
  const dockerUrl = `file://telegram-bot-api${src}`;
  const copied = await downloadToTemp(dockerUrl, 'docker-test.txt');
  assert.equal(await readFile(copied, 'utf8'), 'docker-payload');
  await cleanTemp(copied);
});
