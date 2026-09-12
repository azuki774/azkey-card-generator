import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { renderCards } from '../src/card-renderer.js';

const date = new Date('2026-01-01T00:00:00.000Z');
const baseProfile = { username: '@alice', displayName: 'Alice', notesCount: 0 };

async function decoded(image: Buffer): Promise<Buffer> {
  return sharp(image).ensureAlpha().raw().toBuffer();
}

test('missing and corrupt avatars produce the same fallback front', async () => {
  const missing = await decoded((await renderCards(baseProfile, date)).front);
  const corrupt = await decoded((await renderCards({ ...baseProfile, avatar: Buffer.from('not-an-image') }, date)).front);
  assert.deepEqual(corrupt, missing);
});

async function stripedAvatar(): Promise<Buffer> {
  return sharp({ create: { width: 640, height: 160, channels: 3, background: { r: 240, g: 30, b: 30 } } })
    .composite([
      { input: { create: { width: 160, height: 160, channels: 3, background: { r: 30, g: 50, b: 240 } } }, left: 240, top: 0 },
      { input: { create: { width: 240, height: 160, channels: 3, background: { r: 30, g: 190, b: 50 } } }, left: 400, top: 0 },
    ])
    .png()
    .toBuffer();
}

test('supplied avatars use a centered cover crop without stretching', async () => {
  const front = (await renderCards({ ...baseProfile, avatar: await stripedAvatar() }, date)).front;
  for (const left of [96, 352]) {
    const pixel = await sharp(front).extract({ left, top: 384, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.deepEqual([...pixel], [30, 50, 240]);
  }
});
