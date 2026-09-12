import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import sharp from 'sharp';

import { MisskeyClient, MisskeyError } from '../src/misskey-client.js';
import { DEFAULT_MISSKEY_HOST, misskeyBaseUrlFromEnv } from '../src/misskey-config.js';

async function withServer(handler: (body: unknown, req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void, fn: (url: string) => Promise<void>) {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => handler(body ? JSON.parse(body) : {}, req, res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await fn(`http://127.0.0.1:${address.port}`); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test('client sends stripped username, preserves unknown fields, and downloads avatar', async () => {
  const avatar = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#7654f5' } }).png().toBuffer();
  await withServer((body, req, res) => {
    if (req.url === '/avatar') { res.setHeader('content-type', 'image/png'); res.end(avatar); return; }
    if ((body as { username: string }).username === 'alice') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'id', username: 'alice', name: ' Alice ', notesCount: 2, avatarUrl: `http://${req.headers.host}/avatar`, extra: true })); }
  }, async (url) => {
    const client = new MisskeyClient({ baseUrl: url });
    const user = await client.getUserInfo('@alice');
    assert.equal(user.extra, true);
    assert.equal(user.username, 'alice');
    const downloaded = await client.getAvatar(user);
    assert.ok(downloaded);
    assert.equal((await sharp(downloaded.data).metadata()).format, 'png');
  });
});

test('maps status and malformed responses to typed errors', async () => {
  for (const [status, kind] of [[404, 'not_found'], [429, 'rate_limited'], [502, 'upstream']] as const) {
    await withServer((_body, _req, res) => { res.statusCode = status; res.end('{}'); }, async (url) => {
      await assert.rejects(() => new MisskeyClient({ baseUrl: url }).getUserInfo('alice'), (error: unknown) => error instanceof MisskeyError && error.kind === kind);
    });
  }
  await withServer((_body, _req, res) => { res.end('{'); }, async (url) => {
    await assert.rejects(() => new MisskeyClient({ baseUrl: url }).getUserInfo('alice'), (error: unknown) => error instanceof MisskeyError && error.kind === 'invalid_response');
  });
});

test('default host and override are explicit', () => {
  assert.equal(DEFAULT_MISSKEY_HOST, 'azkey.azuki.blue');
  assert.equal(misskeyBaseUrlFromEnv({}), 'https://azkey.azuki.blue');
  assert.equal(misskeyBaseUrlFromEnv({ MISSKEY_BASE_URL: 'http://localhost:4100' }), 'http://localhost:4100');
});

test('rejects redirects, oversized JSON, invalid avatar origins and corrupt images', async () => {
  let redirected = 0;
  await withServer((_body, req, res) => {
    if (req.url === '/corrupt') { res.setHeader('content-type', 'image/png'); res.end('not-png'); return; }
    if (req.url === '/api/users/show') { res.statusCode = 302; res.setHeader('location', '/other'); res.end(); }
    else { redirected += 1; res.end('{}'); }
  }, async (url) => {
    await assert.rejects(() => new MisskeyClient({ baseUrl: url }).getUserInfo('alice'));
  });
  assert.equal(redirected, 0);

  await withServer((_body, _req, res) => { res.setHeader('content-type', 'application/json'); res.end('x'.repeat(1_048_577)); }, async (url) => {
    await assert.rejects(() => new MisskeyClient({ baseUrl: url }).getUserInfo('alice'), (error: unknown) => error instanceof MisskeyError && error.kind === 'upstream');
  });

  await withServer((_body, req, res) => {
    if (req.url === '/api/users/show') { res.end(JSON.stringify({ id: 'id', username: 'alice', name: null, notesCount: 0, avatarUrl: 'https://evil.example/a.png' })); return; }
    res.setHeader('content-type', 'image/png'); res.end(Buffer.from('not-png'));
  }, async (url) => {
    const client = new MisskeyClient({ baseUrl: url });
    const user = await client.getUserInfo('alice');
    assert.equal(await client.getAvatar({ avatarUrl: null }), null);
    await assert.rejects(() => client.getAvatar(user), (error: unknown) => error instanceof MisskeyError && error.kind === 'avatar_rejected');
    await assert.rejects(() => client.getAvatar({ avatarUrl: 'ftp://127.0.0.1/avatar' }), (error: unknown) => error instanceof MisskeyError && error.kind === 'avatar_rejected');
    await assert.rejects(() => client.getAvatar({ avatarUrl: `${url}/corrupt` }), (error: unknown) => error instanceof MisskeyError && error.kind === 'avatar_rejected');
  });
});

test('times out while response body is slow', async () => {
  await withServer((_body, _req, res) => {
    res.write('{"id":"id"');
    setTimeout(() => res.end('}'), 1000);
  }, async (url) => {
    await assert.rejects(() => new MisskeyClient({ baseUrl: url, timeoutMs: 50 }).getUserInfo('alice'), (error: unknown) => error instanceof MisskeyError && error.kind === 'timeout');
  });
});

test('rejects SVG disguised as PNG and oversized avatars', async () => {
  await withServer((_body, req, res) => {
    if (req.url === '/api/users/show') { res.end(JSON.stringify({ id: 'id', username: 'alice', name: null, notesCount: 0, avatarUrl: `http://${req.headers.host}/avatar` })); return; }
    res.setHeader('content-type', 'image/png'); res.end('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  }, async (url) => {
    const client = new MisskeyClient({ baseUrl: url });
    const user = await client.getUserInfo('alice');
    await assert.rejects(() => client.getAvatar(user), (error: unknown) => error instanceof MisskeyError && error.kind === 'avatar_rejected');
  });
  await withServer((_body, req, res) => {
    if (req.url === '/api/users/show') { res.end(JSON.stringify({ id: 'id', username: 'alice', name: null, notesCount: 0, avatarUrl: `http://${req.headers.host}/avatar` })); return; }
    res.setHeader('content-type', 'image/png'); res.end(Buffer.alloc(5 * 1024 * 1024 + 1));
  }, async (url) => {
    const client = new MisskeyClient({ baseUrl: url });
    const user = await client.getUserInfo('alice');
    await assert.rejects(() => client.getAvatar(user), (error: unknown) => error instanceof MisskeyError && error.kind === 'upstream');
  });
});
