import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { renderCards as issueCards } from '../src/card-renderer.js';

const cardId = '93e97edb-b33e-4af6-a6e1-fad674a5b11b';
const renderCards = (profile: Parameters<typeof issueCards>[0], date: Date) => issueCards(profile, date, cardId);

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

test('back retains registration date in UTC with missing and invalid fallback', async () => {
  const missing = await renderCards(baseProfile, date);
  const invalid = await renderCards({ ...baseProfile, registrationDate: 'invalid' }, date);
  const registered = await renderCards({ ...baseProfile, registrationDate: '2024-05-06T00:30:00Z' }, date);
  const equivalent = await renderCards({ ...baseProfile, registrationDate: '2024-05-05T20:30:00-04:00' }, date);
  assert.deepEqual(await decoded(missing.back), await decoded(invalid.back));
  assert.deepEqual(await decoded(registered.back), await decoded(equivalent.back));
  assert.notDeepEqual(await decoded(missing.back), await decoded(registered.back));
  assert.deepEqual(await footer(missing.back), await footer(registered.back));
});

const footer = (image: Buffer) => sharp(image).extract({ left: 432, top: 656, width: 704, height: 80 }).raw().toBuffer();

test('both footers share issuance details independently of account identifiers', async () => {
  const first = await renderCards({ ...baseProfile, userId: 'account-a' }, date);
  const other = await renderCards({ ...baseProfile, username: '@bob', userId: 'account-b' }, date);
  assert.deepEqual(await footer(first.front), await footer(first.back));
  assert.deepEqual(await footer(first.front), await footer(other.front));
  assert.deepEqual(await footer(first.back), await footer(other.back));
});

test('issuance timestamp and UUID each affect both footers', async () => {
  const first = await renderCards(baseProfile, date);
  const later = await renderCards(baseProfile, new Date('2026-01-02T03:04:05Z'));
  const otherId = await issueCards(baseProfile, date, 'f8b9d73c-6df7-41cc-97ee-20df523f1201');
  for (const side of ['front', 'back'] as const) {
    assert.notDeepEqual(await footer(first[side]), await footer(later[side]));
    assert.notDeepEqual(await footer(first[side]), await footer(otherId[side]));
  }
});

test('each issuance generates a new UUID shared by both sides', async () => {
  const first = await issueCards(baseProfile, date);
  const second = await issueCards(baseProfile, date);
  assert.match(first.cardId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first.cardId, second.cardId);
  const reproduced = await issueCards(baseProfile, date, first.cardId);
  assert.deepEqual(await decoded(first.front), await decoded(reproduced.front));
  assert.deepEqual(await decoded(first.back), await decoded(reproduced.back));
  assert.deepEqual(await footer(first.front), await footer(first.back));
  assert.deepEqual(await footer(second.front), await footer(second.back));
  assert.notDeepEqual(await footer(first.front), await footer(second.front));
});

test('back counts distinguish zero from unavailable and update independently', async () => {
  const missing = await renderCards(baseProfile, date);
  const zero = await renderCards({ ...baseProfile, followingCount: 0, followersCount: 0 }, date);
  const counts = await renderCards({ ...baseProfile, followingCount: 1234, followersCount: 5678 }, date);
  const invalid = await renderCards({ ...baseProfile, followingCount: -1, followersCount: NaN }, date);
  assert.deepEqual(await decoded(missing.back), await decoded(invalid.back));
  assert.notDeepEqual(await decoded(missing.back), await decoded(zero.back));
  assert.notDeepEqual(await decoded(zero.back), await decoded(counts.back));
  assert.deepEqual(await decoded(missing.front), await decoded(counts.front));
});

test('front and back use the same background image', async () => {
  const cards = await renderCards(baseProfile, date);
  const [frontPixel, backPixel] = await Promise.all([
    sharp(cards.front).extract({ left: 20, top: 700, width: 1, height: 1 }).removeAlpha().raw().toBuffer(),
    sharp(cards.back).extract({ left: 20, top: 700, width: 1, height: 1 }).removeAlpha().raw().toBuffer(),
  ]);
  assert.deepEqual(frontPixel, backPixel);
});
