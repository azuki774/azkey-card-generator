import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import sharp from 'sharp';

import { renderCards } from '../src/card-renderer.js';
import {
  AVATAR_SIZE_PX,
  MAX_INPUT_PIXELS,
  MisskeyClient,
  MisskeyError,
} from '../src/misskey-client.js';

async function withAvatarServer(
  avatar: { bytes: Buffer; contentType: string },
  fn: (url: string) => Promise<void>,
) {
  const server: Server = createServer((req, res) => {
    if (req.url === '/avatar') {
      res.setHeader('content-type', avatar.contentType);
      res.end(avatar.bytes);
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function fetchedAvatar(bytes: Buffer, contentType: string) {
  let result: { data: Buffer; contentType: string } | null = null;
  await withAvatarServer({ bytes, contentType }, async (url) => {
    const client = new MisskeyClient({ baseUrl: url });
    const avatar = await client.getAvatar({ avatarUrl: `${url}/avatar` });
    assert.ok(avatar);
    result = avatar;
  });
  assert.ok(result);
  return result;
}

test('pixel limit default bounds decoded output for the 320x320 slot', () => {
  assert.equal(AVATAR_SIZE_PX, 320);
  assert.equal(MAX_INPUT_PIXELS, 4_000_000);
  assert.ok(MAX_INPUT_PIXELS * 4 <= 32 * 1024 * 1024);
});

for (const format of ['png', 'jpeg', 'webp', 'gif'] as const) {
  test(`valid ${format} avatar normalizes to bounded 320x320 PNG`, async () => {
    const source = await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#123456' },
    })
      .toFormat(format)
      .toBuffer();
    const contentType =
      format === 'jpeg' ? 'image/jpeg' : (`image/${format}` as string);
    const avatar = await fetchedAvatar(source, contentType);
    assert.equal(avatar.contentType, 'image/png');
    const metadata = await sharp(avatar.data).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 320);
    assert.equal(metadata.height, 320);
    // Normalized card-ready output stays small (well under the 5MB download cap).
    assert.ok(avatar.data.length < 1_024 * 1024);
  });
}

test('animated GIF normalizes only the first frame', async () => {
  const frameBytes = 16 * 16 * 3;
  const pixels = Buffer.alloc(frameBytes * 2);
  for (let i = 0; i < frameBytes; i += 3) {
    pixels[i] = 255;
    pixels[frameBytes + i + 2] = 255;
  }
  const gif = await sharp(pixels, {
    raw: { width: 16, height: 32, channels: 3, pageHeight: 16 },
  }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
  assert.equal((await sharp(gif, { animated: true }).metadata()).pages, 2);
  const avatar = await fetchedAvatar(gif, 'image/gif');
  const metadata = await sharp(avatar.data).metadata();
  assert.deepEqual([metadata.width, metadata.height, metadata.pages ?? 1], [320, 320, 1]);
  const center = await sharp(avatar.data)
    .extract({ left: 160, top: 160, width: 1, height: 1 })
    .removeAlpha().raw().toBuffer();
  assert.deepEqual([...center], [255, 0, 0]);
});

test('oversized dimensions are rejected at the metadata stage with a small compressed fixture', async () => {
  // 2048x2048 = 4,194,304 pixels (> 4M limit) but a solid color compresses
  // to kilobytes, proving rejection is by decoded dimensions rather than the
  // 5MB compressed download cap, without loading huge buffers in the test.
  const oversized = await sharp({
    create: { width: 2048, height: 2048, channels: 3, background: '#7654f5' },
  })
    .png()
    .toBuffer();
  assert.ok(oversized.length < 256 * 1024, `fixture should stay small, got ${oversized.length}`);
  await withAvatarServer({ bytes: oversized, contentType: 'image/png' }, async (url) => {
    const client = new MisskeyClient({ baseUrl: url });
    await assert.rejects(
      () => client.getAvatar({ avatarUrl: `${url}/avatar` }),
      (error: unknown) => error instanceof MisskeyError && error.kind === 'avatar_rejected',
    );
  });
});

test('pixel boundary: exactly 4M pixels is accepted, just over is rejected', async () => {
  const atLimit = await sharp({
    create: { width: 2000, height: 2000, channels: 3, background: '#7654f5' },
  })
    .png()
    .toBuffer();
  const accepted = await fetchedAvatar(atLimit, 'image/png');
  const metadata = await sharp(accepted.data).metadata();
  assert.deepEqual([metadata.format, metadata.width, metadata.height], ['png', 320, 320]);

  const justOver = await sharp({
    create: { width: 2001, height: 2000, channels: 3, background: '#7654f5' },
  })
    .png()
    .toBuffer();
  assert.ok(justOver.length < 5 * 1024 * 1024);
  await withAvatarServer({ bytes: justOver, contentType: 'image/png' }, async (url) => {
    const client = new MisskeyClient({ baseUrl: url });
    await assert.rejects(
      () => client.getAvatar({ avatarUrl: `${url}/avatar` }),
      (error: unknown) => error instanceof MisskeyError && error.kind === 'avatar_rejected',
    );
  });
});

test('disguised SVG, MIME mismatch, and corruption are rejected', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  await assert.rejects(() => fetchedAvatar(svg, 'image/png'));

  const jpeg = await sharp({
    create: { width: 16, height: 16, channels: 3, background: '#fff' },
  })
    .jpeg()
    .toBuffer();
  // Real bytes are JPEG but the declared MIME claims PNG.
  await assert.rejects(() => fetchedAvatar(jpeg, 'image/png'));

  const png = await sharp({
    create: { width: 16, height: 16, channels: 3, background: '#fff' },
  })
    .png()
    .toBuffer();
  await assert.rejects(() => fetchedAvatar(png.subarray(0, png.length - 32), 'image/png'));
  await assert.rejects(() => fetchedAvatar(Buffer.from('not-an-image'), 'image/png'));
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

test('normalization keeps center-cover semantics', async () => {
  const avatar = await fetchedAvatar(await stripedAvatar(), 'image/png');
  // 640x160 cover-scaled to 1280x320 then centre-cropped to 320x320 lands
  // entirely in the middle blue stripe (original x 240-400).
  const center = await sharp(avatar.data)
    .extract({ left: 160, top: 160, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer();
  assert.deepEqual([...center], [30, 50, 240]);
});

test('normalized avatar and corrupt input render end-to-end via renderer fallback', async () => {
  const date = new Date('2026-01-01T00:00:00.000Z');
  const baseProfile = { username: '@alice', displayName: 'Alice', notesCount: 0 };
  const normalized = await fetchedAvatar(await stripedAvatar(), 'image/png');

  const withAvatar = await renderCards({ ...baseProfile, avatar: normalized.data }, date, '93e97edb-b33e-4af6-a6e1-fad674a5b11b');
  const missing = await renderCards(baseProfile, date, '93e97edb-b33e-4af6-a6e1-fad674a5b11b');
  const corrupt = await renderCards(
    { ...baseProfile, avatar: Buffer.from('not-an-image') },
    date,
    '93e97edb-b33e-4af6-a6e1-fad674a5b11b',
  );
  const decode = (image: Buffer) => sharp(image).ensureAlpha().raw().toBuffer();
  // Corrupt input falls back to the same output as a missing avatar.
  assert.deepEqual(await decode(corrupt.front), await decode(missing.front));
  // A normalized avatar renders distinctly from the fallback.
  assert.notDeepEqual(await decode(withAvatar.front), await decode(missing.front));
});
