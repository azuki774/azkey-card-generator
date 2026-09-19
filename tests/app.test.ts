import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { buildApp } from '../src/app.js';
import { renderCards } from '../src/card-renderer.js';
import { buildMockMisskey } from '../src/mock-misskey.js';
import { MisskeyClient } from '../src/misskey-client.js';
import { MisskeyProfileSource } from '../src/profile-source.js';
import { MisskeyError } from '../src/misskey-client.js';

const stubProfileSource = { getProfile: async (username: string) => ({ username, displayName: 'Alice', notesCount: 0 }) };

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
  const app = buildApp({ profileSource: stubProfileSource });
  try {
    const response = await app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] ?? '', /^text\/html/);
    assert.match(response.body, /<script src="\/assets\/app\.js" defer><\/script>/);
    assert.match(response.body, /<h2>カードプレビュー<\/h2>/);
    assert.match(response.body, /class="input-prefix"[^>]*>@<\/span>/);
    assert.match(response.body, /name="username"[^>]*placeholder="例: azuki"/);
    assert.match(response.body, /<h1 id="page-title">azkey <span>プロフカード作成<\/span><\/h1>/);
    assert.match(response.body, /aria-describedby="form-error"/);
    assert.doesNotMatch(response.body, /username-hint|input-hint|英数字・アンダースコア/);
    assert.doesNotMatch(response.body, /1〜(?:20|100)文字/);
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
  const app = buildApp({ profileSource: stubProfileSource });
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
    assert.match(script.body, /X-Card-Request/);
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
    profileSource: { getProfile: async (username) => ({ username, displayName: 'Alice', notesCount: 0 }) },
    render: async () => ({ cardId: '93e97edb-b33e-4af6-a6e1-fad674a5b11b', front: Buffer.from('front-png'), back: Buffer.from('back-png') }),
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/cards',
      payload: 'username=%20%40alice%20',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-card-request': '1' },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] ?? '', /^application\/json/);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(response.json(), {
      generatedAt: '2026-01-01T00:00:00.000Z',
      cards: {
        front: { data: Buffer.from('front-png').toString('base64'), mediaType: 'image/png', fileName: 'front-azkcard-93e97edb-b33e-4af6-a6e1-fad674a5b11b.png' },
        back: { data: Buffer.from('back-png').toString('base64'), mediaType: 'image/png', fileName: 'back-azkcard-93e97edb-b33e-4af6-a6e1-fad674a5b11b.png' },
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
    render: async () => ({ cardId: '93e97edb-b33e-4af6-a6e1-fad674a5b11b', front: Buffer.from('front-png'), back: Buffer.from('back-png') }),
  });
  try {
    for (const name of ['alice', 'a'.repeat(21), 'a'.repeat(100)]) {
      for (const prefix of ['', '@']) {
        const response = await app.inject({
          method: 'POST',
          url: '/cards',
          payload: new URLSearchParams({ username: ` ${prefix}${name} ` }).toString(),
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-card-request': '1' },
        });
        assert.equal(response.statusCode, 200);
        assert.equal(loadedUsername, `@${name}`);
      }
    }
  } finally {
    await app.close();
  }
});

test('POST /cards rejects malformed usernames after optional @ normalization', async () => {
  const app = buildApp({ profileSource: stubProfileSource });
  try {
    for (const username of ['@@alice', 'alice@example', 'a'.repeat(101), '@' + 'a'.repeat(101), '']) {
      const response = await app.inject({
        method: 'POST',
        url: '/cards',
        payload: `username=${encodeURIComponent(username)}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-card-request': '1' },
      });
      assert.equal(response.statusCode, 400, username);
      assert.equal(response.json().error.code, 'invalid_username', username);
    }
  } finally {
    await app.close();
  }
});

test('POST /cards rejects invalid usernames with JSON', async () => {
  const app = buildApp({ profileSource: stubProfileSource });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/cards',
      payload: 'username=alice%3Cscript%3E',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-card-request': '1' },
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json().error.code, 'invalid_username');
    assert.doesNotMatch(response.body, /<script>/);
  } finally {
    await app.close();
  }
});

test('renderer failures return a safe JSON error', async () => {
  const app = buildApp({ profileSource: stubProfileSource, render: async () => { throw new Error('internal renderer detail'); } });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/cards',
      payload: 'username=%40alice',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-card-request': '1' },
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
    appRole: 'ＦＵＬＬＷＩＤＴＨ役割ＦＵＬＬＷＩＤＴＨ役割',
    userId: 'user-id-with-optional-fields',
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

test('real mock HTTP supplies user/avatar and /cards generates both PNGs', async () => {
  const mock = buildMockMisskey();
  await mock.listen({ host: '127.0.0.1', port: 0 });
  try {
    const address = mock.server.address(); assert.ok(address && typeof address !== 'string');
    const client = new MisskeyClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const user = await client.getUserInfo('@alice');
    assert.equal(user.unknownField && (user.unknownField as { preserved: boolean }).preserved, true);
    const avatar = await client.getAvatar(user); assert.ok(avatar);
    assert.equal((await (await import('sharp')).default(avatar.data).metadata()).format, 'png');
    const app = buildApp({ profileSource: new MisskeyProfileSource(client) });
    const response = await app.inject({ method: 'POST', url: '/cards', payload: 'username=alice', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-card-request': '1' } });
    assert.equal(response.statusCode, 200);
    const result = response.json();
    assert.equal((await (await import('sharp')).default(Buffer.from(result.cards.front.data, 'base64')).metadata()).width, 1200);
    assert.equal((await (await import('sharp')).default(Buffer.from(result.cards.back.data, 'base64')).metadata()).height, 760);
    await app.close();
  } finally { await mock.close(); }
});

test('/cards maps profile source failures to safe status codes', async () => {
  for (const [kind, status, code] of [
    ['not_found', 404, 'user_not_found'], ['rate_limited', 429, 'upstream_rate_limited'],
    ['upstream', 502, 'profile_source_failed'], ['timeout', 504, 'profile_source_timeout'],
  ] as const) {
    const app = buildApp({ profileSource: { getProfile: async () => { throw new MisskeyError(kind, 'internal'); } } });
    try {
      const response = await app.inject({ method: 'POST', url: '/cards', payload: 'username=alice', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-card-request': '1' } });
      assert.equal(response.statusCode, status); assert.equal(response.json().error.code, code);
    } finally { await app.close(); }
  }
});

test('reissuing a card changes filenames and uses the rendered UUID', async () => {
  const issuedIds: string[] = [];
  const app = buildApp({
    profileSource: stubProfileSource,
    now: () => Date.parse('2026-01-01T00:00:00Z'),
    render: async (profile, date) => {
      const cards = await renderCards(profile, date);
      issuedIds.push(cards.cardId);
      return cards;
    },
  });
  try {
    for (let index = 0; index < 2; index++) {
      const response = await app.inject({ method: 'POST', url: '/cards', payload: { username: 'alice' }, headers: { 'x-card-request': '1' } });
      assert.equal(response.statusCode, 200);
      const { cards } = response.json();
      assert.equal(cards.front.fileName, `front-azkcard-${issuedIds[index]}.png`);
      assert.equal(cards.back.fileName, `back-azkcard-${issuedIds[index]}.png`);
    }
    assert.notEqual(issuedIds[0], issuedIds[1]);
  } finally {
    await app.close();
  }
});

test('POST /cards rejects requests without the dedicated header before loading the profile', async () => {
  let calls = 0;
  const app = buildApp({
    profileSource: {
      getProfile: async (username: string) => {
        calls += 1;
        return { username, displayName: 'Alice', notesCount: 0 };
      },
    },
    render: async () => {
      calls += 1;
      return { cardId: '93e97edb-b33e-4af6-a6e1-fad674a5b11b', front: Buffer.from('front-png'), back: Buffer.from('back-png') };
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/cards',
      payload: 'username=%40alice',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(response.headers['content-type'] ?? '', /^application\/json/);
    assert.equal(response.json().error.code, 'forbidden');
    assert.equal(calls, 0);
  } finally {
    await app.close();
  }
});

test('POST /cards rejects a wrong dedicated header value before loading the profile', async () => {
  let calls = 0;
  const app = buildApp({
    profileSource: {
      getProfile: async (username: string) => {
        calls += 1;
        return { username, displayName: 'Alice', notesCount: 0 };
      },
    },
    render: async () => {
      calls += 1;
      return { cardId: '93e97edb-b33e-4af6-a6e1-fad674a5b11b', front: Buffer.from('front-png'), back: Buffer.from('back-png') };
    },
  });
  try {
    for (const value of ['0', 'true', '']) {
      const response = await app.inject({
        method: 'POST',
        url: '/cards',
        payload: 'username=%40alice',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-card-request': value },
      });
      assert.equal(response.statusCode, 403, value);
      assert.equal(response.json().error.code, 'forbidden', value);
    }
    assert.equal(calls, 0);
  } finally {
    await app.close();
  }
});

test('POST /cards rejects cross-site Fetch Metadata even with the dedicated header', async () => {
  let calls = 0;
  const app = buildApp({
    profileSource: {
      getProfile: async (username: string) => {
        calls += 1;
        return { username, displayName: 'Alice', notesCount: 0 };
      },
    },
    render: async () => {
      calls += 1;
      return { cardId: '93e97edb-b33e-4af6-a6e1-fad674a5b11b', front: Buffer.from('front-png'), back: Buffer.from('back-png') };
    },
  });
  try {
    for (const site of ['cross-site', 'same-site', 'none']) {
      const response = await app.inject({
        method: 'POST',
        url: '/cards',
        payload: 'username=%40alice',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-card-request': '1',
          'sec-fetch-site': site,
        },
      });
      assert.equal(response.statusCode, 403, site);
      assert.equal(response.headers['cache-control'], 'no-store', site);
      assert.equal(response.headers['x-content-type-options'], 'nosniff', site);
      assert.equal(response.json().error.code, 'forbidden', site);
    }
    assert.equal(calls, 0);
  } finally {
    await app.close();
  }
});

test('POST /cards allows same-origin Fetch Metadata with the dedicated header', async () => {
  const app = buildApp({
    profileSource: stubProfileSource,
    render: async () => ({ cardId: '93e97edb-b33e-4af6-a6e1-fad674a5b11b', front: Buffer.from('front-png'), back: Buffer.from('back-png') }),
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/cards',
      payload: 'username=%40alice',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-card-request': '1',
        'sec-fetch-site': 'same-origin',
      },
    });
    assert.equal(response.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('POST /cards allows JSON with the dedicated header and no Fetch Metadata (direct client)', async () => {
  const app = buildApp({
    profileSource: stubProfileSource,
    render: async () => ({ cardId: '93e97edb-b33e-4af6-a6e1-fad674a5b11b', front: Buffer.from('front-png'), back: Buffer.from('back-png') }),
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/cards',
      payload: { username: 'alice' },
      headers: { 'x-card-request': '1' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
  } finally {
    await app.close();
  }
});

test('POST /cards with a query string is guarded the same as the bare route', async () => {
  let calls = 0;
  const app = buildApp({
    profileSource: {
      getProfile: async (username: string) => {
        calls += 1;
        return { username, displayName: 'Alice', notesCount: 0 };
      },
    },
    render: async () => ({ cardId: '93e97edb-b33e-4af6-a6e1-fad674a5b11b', front: Buffer.from('front-png'), back: Buffer.from('back-png') }),
  });
  try {
    const denied = await app.inject({
      method: 'POST',
      url: '/cards?next=/cards',
      payload: 'username=%40alice',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.code, 'forbidden');
    const allowed = await app.inject({
      method: 'POST',
      url: '/cards?next=/cards',
      payload: 'username=%40alice',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-card-request': '1' },
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
});

test('untrusted Origin preflight for /cards is never granted CORS access', async () => {
  const app = buildApp({ profileSource: stubProfileSource });
  try {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/cards',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-card-request',
      },
    });
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['access-control-allow-headers'], undefined);
  } finally {
    await app.close();
  }
});
