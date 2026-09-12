import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { buildApp } from '../src/app.js';
import { renderCards } from '../src/card-renderer.js';

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeRgbPng(png: Buffer): { width: number; height: number; pixels: Buffer } {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks: { type: string; data: Buffer }[] = [];
  let offset = 8;
  while (offset < png.length) {
    assert.ok(offset + 12 <= png.length, 'PNG chunk header is truncated');
    const length = png.readUInt32BE(offset);
    const typeBytes = png.subarray(offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    assert.ok(crcEnd <= png.length, 'PNG chunk data is truncated');
    const data = png.subarray(dataStart, dataEnd);
    assert.equal(png.readUInt32BE(dataEnd), crc32(Buffer.concat([typeBytes, data])));
    chunks.push({ type: typeBytes.toString('ascii'), data });
    offset = crcEnd;
  }

  assert.equal(offset, png.length);
  assert.deepEqual(chunks.map(({ type }) => type), ['IHDR', 'IDAT', 'IEND']);
  const header = chunks[0].data;
  assert.equal(header.readUInt8(8), 8, 'PNG must use 8-bit samples');
  assert.equal(header.readUInt8(9), 2, 'PNG must use RGB color');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const pixels = inflateSync(chunks[1].data);
  assert.equal(pixels.length, (width * 3 + 1) * height);
  return { width, height, pixels };
}

test('GET / returns the front/back generator page', async () => {
  const app = buildApp();
  try {
    const response = await app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] ?? '', /^text\/html/);
    assert.match(response.body, /<script src="\/assets\/app\.js" defer><\/script>/);
    assert.match(response.body, /<h2>カードプレビュー<\/h2>/);
    assert.match(response.body, /class="input-prefix"[^>]*>@<\/span>/);
    assert.match(response.body, /name="username"[^>]*placeholder="username"/);
    assert.match(response.body, /ユーザー名だけ入力してください（@ は自動で付きます）/);
    assert.match(response.body, /data-card-image="front"/);
    assert.match(response.body, /data-card-image="back"/);
    assert.equal((response.body.match(/data-download-link=/g) ?? []).length, 2);
  } finally {
    await app.close();
  }
});

test('card template assets contain valid front and back placeholders', async () => {
  const assetsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/card-templates/default');
  const sides = ['front', 'back'] as const;
  const framePaths = ['icons/placeholder.svg', 'value-frames/placeholder.svg', 'icon-frames/placeholder.svg'];
  const decodedImages = [];

  for (const side of sides) {
    const png = await readFile(resolve(assetsDirectory, side, 'base.png'));
    const decoded = decodeRgbPng(png);
    assert.equal(decoded.width, 1200);
    assert.equal(decoded.height, 760);
    decodedImages.push(decoded);
    for (const framePath of framePaths) {
      const svg = await readFile(resolve(assetsDirectory, side, framePath), 'utf8');
      assert.match(svg, /^<svg\s/);
      assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      assert.match(svg, /fill="none"/);
    }
  }

  assert.notDeepEqual(decodedImages[0].pixels, decodedImages[1].pixels);
});

test('static assets are served', async () => {
  const app = buildApp();
  try {
    const [styles, script] = await Promise.all([
      app.inject({ method: 'GET', url: '/assets/styles.css' }),
      app.inject({ method: 'GET', url: '/assets/app.js' }),
    ]);
    assert.equal(styles.statusCode, 200);
    assert.match(styles.headers['content-type'] ?? '', /^text\/css/);
    assert.match(styles.body, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
    assert.equal(script.statusCode, 200);
    assert.match(script.headers['content-type'] ?? '', /^application\/javascript/);
    assert.match(script.body, /fetch\('\/cards'/);
    assert.match(script.body, /URL\.createObjectURL/);
    assert.match(script.body, /URL\.revokeObjectURL/);
    assert.match(script.body, /new Blob/);
  } finally {
    await app.close();
  }
});

test('POST /cards returns both PNG cards using the documented JSON contract', async () => {
  const generatedAt = Date.parse('2026-01-01T00:00:00.000Z');
  const app = buildApp({
    now: () => generatedAt,
    render: async () => ({ front: Buffer.from('front-png'), back: Buffer.from('back-png') }),
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/cards',
      payload: 'username=%20%40alice%20',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] ?? '', /^application\/json/);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(response.json(), {
      generatedAt: '2026-01-01T00:00:00.000Z',
      cards: {
        front: { data: Buffer.from('front-png').toString('base64'), mediaType: 'image/png', fileName: 'azkey-card-front.png' },
        back: { data: Buffer.from('back-png').toString('base64'), mediaType: 'image/png', fileName: 'azkey-card-back.png' },
      },
    });
  } finally {
    await app.close();
  }
});

test('POST /cards normalizes an unprefixed username before loading the profile', async () => {
  let loadedUsername = '';
  const app = buildApp({
    profileSource: {
      getProfile: async (username) => {
        loadedUsername = username;
        return { username, displayName: 'Alice', notesCount: 0 };
      },
    },
    render: async () => ({ front: Buffer.from('front-png'), back: Buffer.from('back-png') }),
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/cards',
      payload: 'username=%20alice%20',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(loadedUsername, '@alice');
  } finally {
    await app.close();
  }
});

test('POST /cards rejects malformed usernames after optional @ normalization', async () => {
  const app = buildApp();
  try {
    for (const username of ['@@alice', 'alice@example', 'a'.repeat(21), '']) {
      const response = await app.inject({
        method: 'POST',
        url: '/cards',
        payload: `username=${encodeURIComponent(username)}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      assert.equal(response.statusCode, 400, username);
      assert.equal(response.json().error.code, 'invalid_username', username);
    }
  } finally {
    await app.close();
  }
});

test('POST /cards rejects invalid usernames with JSON', async () => {
  const app = buildApp();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/cards',
      payload: 'username=alice%3Cscript%3E',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json().error.code, 'invalid_username');
    assert.doesNotMatch(response.body, /<script>/);
  } finally {
    await app.close();
  }
});

test('renderer failures return a safe JSON error', async () => {
  const app = buildApp({ render: async () => { throw new Error('internal renderer detail'); } });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/cards',
      payload: 'username=%40alice',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error.code, 'image_generation_failed');
    assert.doesNotMatch(response.body, /internal renderer detail/);
  } finally {
    await app.close();
  }
});

test('renderCards creates distinct 1200x760 front and back PNGs', async () => {
  const cards = await renderCards({
    username: '@unsafe_name',
    displayName: '名前 <unsafe>',
    notesCount: 1234,
  }, new Date('2026-01-01T00:00:00.000Z'));
  const sharp = (await import('sharp')).default;
  const [frontMetadata, backMetadata] = await Promise.all([
    sharp(cards.front).metadata(),
    sharp(cards.back).metadata(),
  ]);
  assert.deepEqual(
    [frontMetadata.format, frontMetadata.width, frontMetadata.height],
    ['png', 1200, 760],
  );
  assert.deepEqual(
    [backMetadata.format, backMetadata.width, backMetadata.height],
    ['png', 1200, 760],
  );
  assert.notDeepEqual(cards.front, cards.back);
});
