import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import sharp from 'sharp';

import { renderCards } from '../src/card-renderer.js';

const date = new Date('2026-01-01T00:00:00.000Z');
const baseProfile = { username: '@alice', displayName: 'Alice', notesCount: 0 };
const frontPath = fileURLToPath(new URL('../assets/card-templates/default/front/base.png', import.meta.url));
const roleText = 'あいうえおかきくけこ';

type RawImage = { data: Buffer; width: number; height: number; channels: 4 };

async function raw(image: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: 4 };
}

function crop(image: RawImage, left: number, top: number, width: number, height: number): RawImage {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    image.data.copy(data, y * width * 4, ((top + y) * image.width + left) * 4, ((top + y) * image.width + left + width) * 4);
  }
  return { data, width, height, channels: 4 };
}

function assertSamePixels(left: RawImage, right: RawImage, message: string): void {
  assert.equal(left.width, right.width, message);
  assert.equal(left.height, right.height, message);
  assert.deepEqual(left.data, right.data, message);
}

function assertDifferentPixels(left: RawImage, right: RawImage, message: string): void {
  assert.equal(left.width, right.width, message);
  assert.equal(left.height, right.height, message);
  assert.ok(left.data.some((value, index) => value !== right.data[index]), message);
}

function assertOnlyRegionChanged(before: RawImage, after: RawImage, left: number, top: number, width: number, height: number): void {
  let mismatch: string | undefined;
  for (let y = 0; y < before.height; y += 1) {
    for (let x = 0; x < before.width; x += 1) {
      if (x >= left && x < left + width && y >= top && y < top + height) continue;
      const offset = (y * before.width + x) * 4;
      if (!after.data.subarray(offset, offset + 4).equals(before.data.subarray(offset, offset + 4))) {
        mismatch = `${x},${y}`;
        break;
      }
    }
    if (mismatch) break;
  }
  assert.equal(mismatch, undefined, `unexpected pixel change at ${mismatch ?? 'unknown'}`);
}

for (const [label, appRole] of [['normal role', roleText], ['long role', roleText.repeat(10)]] as const) {
test(`${label} occupies only its reserved box`, async () => {
  const withoutRole = await raw((await renderCards(baseProfile, date)).front);
  const withRole = await raw((await renderCards({ ...baseProfile, appRole }, date)).front);
  assertOnlyRegionChanged(withoutRole, withRole, 432, 224, 664, 48);
  assertDifferentPixels(crop(withoutRole, 432, 224, 664, 48), crop(withRole, 432, 224, 664, 48), 'role should be rendered');
});
}

test('missing and corrupt avatars use the same fallback', async () => {
  const missing = await raw((await renderCards(baseProfile, date)).front);
  const corrupt = await raw((await renderCards({ ...baseProfile, avatar: Buffer.from('not-an-image') }, date)).front);
  assertSamePixels(crop(missing, 64, 224, 320, 320), crop(corrupt, 64, 224, 320, 320), 'invalid avatars should share fallback');
});

async function stripedAvatar(): Promise<Buffer> {
  const valid = Buffer.alloc(640 * 160 * 3);
  for (let y = 0; y < 160; y += 1) {
    for (let x = 0; x < 640; x += 1) {
      const color = x < 240 ? [240, 30, 30] : x < 400 ? [30, 50, 240] : [30, 190, 50];
      valid.set(color, (y * 640 + x) * 3);
    }
  }
  return sharp(valid, { raw: { width: 640, height: 160, channels: 3 } }).png().toBuffer();
}

test('a supplied avatar changes the avatar box and uses a centered cover crop', async () => {
  const missing = await raw((await renderCards(baseProfile, date)).front);
  const supplied = await raw((await renderCards({ ...baseProfile, avatar: await stripedAvatar() }, date)).front);
  assertDifferentPixels(crop(missing, 64, 224, 320, 320), crop(supplied, 64, 224, 320, 320), 'valid avatar should be visible');
  const left = crop(supplied, 64, 224, 320, 320);
  const pixel = (x: number, y: number) => left.data.subarray((y * left.width + x) * 4, (y * left.width + x + 1) * 4);
  assert.ok(pixel(32, 160)[2] > 180 && pixel(32, 160)[0] < 80, 'cover crop should retain the left edge of the centered band');
  assert.ok(pixel(288, 160)[2] > 180 && pixel(288, 160)[0] < 80, 'cover crop should retain the right edge of the centered band');
});

test('rounded avatar corners leave the base image visible outside the clip', async () => {
  const supplied = await raw((await renderCards({ ...baseProfile, avatar: await stripedAvatar() }, date)).front);
  const left = crop(supplied, 64, 224, 320, 320);
  const pixel = (x: number, y: number) => left.data.subarray((y * left.width + x) * 4, (y * left.width + x + 1) * 4);
  const base = await raw(await readFile(frontPath));
  assert.deepEqual(pixel(0, 0), base.data.subarray((224 * base.width + 64) * 4, (224 * base.width + 65) * 4), 'rounded corner should leave the base visible');
});

test('display name changes stay inside its intended box', async () => {
  const blank = await raw((await renderCards({ ...baseProfile, displayName: '', username: '@a' }, date)).front);
  const longName = await raw((await renderCards({ ...baseProfile, displayName: '表示名'.repeat(20), username: '@a' }, date)).front);
  assertOnlyRegionChanged(blank, longName, 432, 336, 664, 72);
  assertDifferentPixels(crop(blank, 432, 336, 664, 72), crop(longName, 432, 336, 664, 72), 'display name should be rendered');
});

test('handle changes stay inside its intended box', async () => {
  const blank = await raw((await renderCards({ ...baseProfile, displayName: '', username: '@a' }, date)).front);
  const longHandle = await raw((await renderCards({ ...baseProfile, displayName: '', username: `@${'W'.repeat(100)}` }, date)).front);
  assertOnlyRegionChanged(blank, longHandle, 432, 432, 664, 56);
  assertDifferentPixels(crop(blank, 432, 432, 664, 56), crop(longHandle, 432, 432, 664, 56), 'handle should be rendered');
});

test('display names are literal text and escape markup', async () => {
  const markup = await raw((await renderCards({ ...baseProfile, displayName: '<b>Alice</b>' }, date)).front);
  const plain = await raw((await renderCards({ ...baseProfile, displayName: 'Alice' }, date)).front);
  assertDifferentPixels(crop(markup, 432, 336, 664, 72), crop(plain, 432, 336, 664, 72), 'markup-looking text should remain literal text');
  await renderCards({ ...baseProfile, displayName: '<b>&"' }, date);
});
