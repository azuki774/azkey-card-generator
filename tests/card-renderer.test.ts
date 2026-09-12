import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { fitText, rasterText, renderCards } from '../src/card-renderer.js';

const date = new Date('2026-01-01T00:00:00.000Z');

test('text fitting keeps short text at max size and shrinks before ellipsis', async () => {
  const large = await rasterText('Azuki', 48, 700, '#242032');
  const small = await rasterText('Azuki', 24, 700, '#242032');
  assert.ok(large.width > small.width);
  const wide48 = await rasterText('W'.repeat(20), 48, 700, '#242032');
  const wide24 = await rasterText('W'.repeat(20), 24, 700, '#242032');
  const midpoint = Math.floor((wide48.width + wide24.width) / 2);
  const intermediate = await fitText('W'.repeat(20), midpoint, 48, 24, 700);
  assert.ok(intermediate.size > 24 && intermediate.size < 48);
  assert.equal(intermediate.text, 'W'.repeat(20));
  assert.deepEqual(await fitText('Alice', 664, 48, 24, 800), { text: 'Alice', size: 48 });
  const fitted = await fitText('W'.repeat(100), 664, 40, 24, 700);
  assert.equal(fitted.size, 24);
  assert.match(fitted.text, /…$/u);
  const raster = await rasterText(fitted.text, fitted.size, 700, '#7654f5');
  assert.ok(raster.width <= 664);
});

test('text fitting normalizes whitespace and keeps emoji graphemes intact', async () => {
  const sequence = '😀‍👩‍👧‍👦が';
  const fitted = await fitText(sequence.repeat(30), 200, 40, 24, 700);
  const prefix = fitted.text.replace(/…$/u, '');
  assert.equal(sequence.repeat(30).startsWith(prefix), true);
  assert.equal([...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(prefix)].map(({ segment }) => segment).join(''), prefix);
  assert.doesNotMatch(fitted.text, /\u200d$/u);
  assert.doesNotMatch(fitted.text, /\u200d…$/u);
  assert.deepEqual(await fitText('  A\n\tB  ', 664, 40, 24, 700), { text: 'A B', size: 40 });
});

test('empty role leaves the display-name raster unchanged', async () => {
  const base = { username: '@alice', displayName: 'Sample User', notesCount: 0 };
  const [withoutRole, withRole] = await Promise.all([
    renderCards(base, date),
    renderCards({ ...base, appRole: 'Engineer' }, date),
  ]);
  const crop = (image: Buffer) => sharp(image).extract({ left: 432, top: 336, width: 664, height: 72 }).png().toBuffer();
  assert.deepEqual(await crop(withoutRole.front), await crop(withRole.front));
  const fullwidth = await renderCards({ ...base, appRole: '全角役割名全角役割名' }, date);
  const rolePixels = await sharp(fullwidth.front).extract({ left: 432, top: 224, width: 664, height: 48 }).raw().toBuffer();
  assert.ok(rolePixels.some((pixel) => pixel < 230));
  assert.deepEqual(await crop(withoutRole.front), await crop(fullwidth.front));
  await renderCards({ ...base, displayName: '<b>&"' }, date);
});

test('missing and corrupt avatars use the same deterministic fallback', async () => {
  const base = { username: '@alice', displayName: 'Alice', notesCount: 0 };
  const [missing, corrupt] = await Promise.all([
    renderCards(base, date),
    renderCards({ ...base, avatar: Buffer.from('not-an-image') }, date),
  ]);
  const crop = (image: Buffer) => sharp(image).extract({ left: 64, top: 224, width: 320, height: 320 }).png().toBuffer();
  assert.deepEqual(await crop(missing.front), await crop(corrupt.front));
});

test('nonsquare avatars are center-cropped and rounded', async () => {
  const avatar = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="160"><rect width="240" height="160" fill="red"/><rect x="240" width="160" height="160" fill="blue"/><rect x="400" width="240" height="160" fill="green"/></svg>');
  const card = await renderCards({ username: '@alice', displayName: 'Alice', notesCount: 0, avatar }, date);
  const { data, info } = await sharp(card.front).extract({ left: 64, top: 224, width: 320, height: 320 }).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 320);
  const center = (160 * 320 + 160) * 3;
  assert.ok(data[center] < 40 && data[center + 1] < 40 && data[center + 2] > 220);
  assert.ok(data[0] > 0 && data[1] > 0 && data[2] > 0, 'rounded corner retains base pixels');
});
