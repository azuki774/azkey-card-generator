import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import { MisskeyError, MisskeyClient } from '../src/misskey-client.js';
import { CachedProfileSource, DEFAULT_PROFILE_CACHE_CONFIG, profileCacheConfigFromEnv } from '../src/profile-cache.js';
import {
  DEFAULT_REQUEST_LIMITS_CONFIG,
  UpstreamCooldown,
  parseRetryAfterMs,
  requestLimitsConfigFromEnv,
  retryAfterSeconds,
} from '../src/request-limits.js';
import { MisskeyProfileSource } from '../src/profile-source.js';

// Every /cards request carries this header so a future same-origin
// custom-header check keeps passing.
const CARD_HEADERS = { 'content-type': 'application/x-www-form-urlencoded', 'x-card-request': '1' };

const stubRender = async () => ({
  cardId: '93e97edb-b33e-4af6-a6e1-fad674a5b11b',
  front: Buffer.from('front-png'),
  back: Buffer.from('back-png'),
});

function stubSource(impl?: (username: string) => Promise<{ username: string; displayName: string; notesCount: number }>) {
  let calls = 0;
  const source = {
    get calls() { return calls; },
    getProfile: async (username: string) => {
      calls += 1;
      if (impl) return impl(username);
      return { username, displayName: 'Alice', notesCount: 0 };
    },
  };
  return source;
}

async function postCard(app: ReturnType<typeof buildApp>, username = 'alice', remoteAddress?: string) {
  return app.inject({
    method: 'POST',
    url: '/cards',
    payload: `username=${encodeURIComponent(username)}`,
    headers: CARD_HEADERS,
    ...(remoteAddress ? { remoteAddress } : {}),
  });
}

test('no per-IP quota: many sequential requests from one IP all succeed', async () => {
  const source = stubSource();
  const app = buildApp({ profileSource: source, render: stubRender, profileCache: false });
  try {
    for (let index = 0; index < 15; index += 1) {
      const response = await postCard(app, 'alice');
      assert.equal(response.statusCode, 200, `request ${index + 1} should not be rate limited`);
    }
    assert.equal(source.calls, 15);
  } finally {
    await app.close();
  }
});

test('no per-IP quota: distinct IPs are never counted or rejected', async () => {
  const source = stubSource();
  const app = buildApp({ profileSource: source, render: stubRender, profileCache: false });
  try {
    for (let index = 0; index < 12; index += 1) {
      const response = await postCard(app, `user${index}`, `10.0.0.${index + 1}`);
      assert.equal(response.statusCode, 200, `IP 10.0.0.${index + 1} should not be limited`);
    }
    assert.equal(source.calls, 12);
  } finally {
    await app.close();
  }
});

test('concurrency gate rejects immediately with no queue and releases on all outcomes', async () => {
  const source = stubSource();
  let enteredResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  let releaseFirst: (() => void) | undefined;
  let released = false;
  const releaseOnce = () => {
    if (!released) {
      released = true;
      releaseFirst?.();
    }
  };
  let renderCalls = 0;
  const gateRender = () => {
    renderCalls += 1;
    // Only the first pipeline blocks; later calls resolve immediately so a
    // follow-up request after release can never hang the test.
    if (renderCalls === 1) {
      return new Promise<Awaited<ReturnType<typeof stubRender>>>((resolve) => {
        releaseFirst = () => resolve({ cardId: 'id-1', front: Buffer.from('f'), back: Buffer.from('b') });
        enteredResolve();
      });
    }
    return stubRender();
  };
  const app = buildApp({ profileSource: source, render: gateRender, profileCache: false, requestLimits: { maxConcurrent: 1 } });
  let first: Promise<Awaited<ReturnType<typeof postCard>>> | undefined;
  try {
    first = postCard(app, 'alice');
    await Promise.race([
      entered,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('first render never started')), 5_000)),
    ]);
    const busy = await postCard(app, 'bob');
    assert.equal(busy.statusCode, 429);
    assert.equal(busy.json().error.code, 'rate_limited');
    assert.equal(Number(busy.headers['retry-after']), 2);
    releaseOnce();
    assert.equal((await first).statusCode, 200);
    first = undefined;
    // Gate released after success: next request passes.
    assert.equal((await postCard(app, 'carol')).statusCode, 200);
  } finally {
    // Always release so a failed assertion cannot leave the pipeline hanging
    // and stall app.close().
    releaseOnce();
    if (first) await first.then(() => undefined, () => undefined);
    await app.close();
  }
});

test('concurrency gate releases after renderer failure', async () => {
  const source = stubSource();
  let shouldFail = true;
  const app = buildApp({
    profileSource: source,
    render: async () => {
      if (shouldFail) throw new Error('boom');
      return stubRender();
    },
    profileCache: false,
    requestLimits: { maxConcurrent: 1 },
  });
  try {
    assert.equal((await postCard(app, 'alice')).statusCode, 500);
    shouldFail = false;
    assert.equal((await postCard(app, 'bob')).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('concurrency gate releases after profile failure', async () => {
  const source = stubSource(async () => { throw new MisskeyError('upstream', 'bad'); });
  const app = buildApp({ profileSource: source, render: stubRender, profileCache: false, requestLimits: { maxConcurrent: 1 } });
  try {
    assert.equal((await postCard(app, 'alice')).statusCode, 502);
    // The same gate must still serve after the failure (no leaked slot).
    assert.equal((await postCard(app, 'bob')).statusCode, 502);
    assert.equal(source.calls, 2);
  } finally {
    await app.close();
  }
});

test('upstream 429 triggers cooldown with Retry-After and short-circuits later requests', async () => {
  let nowMs = 1_000_000;
  let calls = 0;
  const source = {
    getProfile: async (username: string) => {
      calls += 1;
      throw new MisskeyError('rate_limited', 'limited', { retryAfterHeader: '2' });
    },
  };
  const app = buildApp({
    profileSource: source,
    render: stubRender,
    profileCache: false,
    now: () => nowMs,
  });
  try {
    const first = await postCard(app, 'alice');
    assert.equal(first.statusCode, 429);
    assert.equal(first.json().error.code, 'upstream_rate_limited');
    assert.ok(Number(first.headers['retry-after']) >= 2, `Retry-After honors Retry-After header: ${first.headers['retry-after']}`);
    assert.equal(calls, 1);
    // Cooldown active: upstream is not consulted again.
    const second = await postCard(app, 'bob');
    assert.equal(second.statusCode, 429);
    assert.equal(second.json().error.code, 'upstream_rate_limited');
    assert.equal(calls, 1);
    // After cooldown expiry, upstream is consulted again.
    nowMs += 5_000;
    const third = await postCard(app, 'carol');
    assert.equal(third.statusCode, 429);
    assert.equal(calls, 2);
  } finally {
    await app.close();
  }
});

test('swallowed avatar 429 still cools down upstream but serves the profile', async () => {
  const retryAfter = '5';
  let notified: MisskeyError | undefined;
  const client = {
    getUserInfo: async () => ({ id: 'id', username: 'alice', name: 'Alice', notesCount: 3, avatarUrl: 'https://example.test/a.png' }),
    getAvatar: async (): Promise<never> => {
      throw new MisskeyError('rate_limited', 'avatar limited', { retryAfterHeader: retryAfter });
    },
  } as unknown as MisskeyClient;
  const source = new MisskeyProfileSource(client, (error) => { notified = error; });
  const profile = await source.getProfile('@alice');
  assert.equal(profile.username, '@alice');
  assert.equal(profile.avatar, undefined);
  assert.equal(notified?.kind, 'rate_limited');
  assert.equal(notified?.retryAfterHeader, retryAfter);
});

test('swallowed avatar 429 shares the cooldown and blocks later /cards without source calls', async () => {
  let nowMs = 1_000_000;
  const cooldown = new UpstreamCooldown(30_000, 300_000, () => nowMs);
  let userCalls = 0;
  let avatarCalls = 0;
  const client = {
    getUserInfo: async () => {
      userCalls += 1;
      return { id: 'id', username: 'alice', name: 'Alice', notesCount: 3, avatarUrl: 'https://example.test/a.png' };
    },
    getAvatar: async (): Promise<never> => {
      avatarCalls += 1;
      throw new MisskeyError('rate_limited', 'avatar limited', { retryAfterHeader: '5' });
    },
  } as unknown as MisskeyClient;
  const source = new MisskeyProfileSource(client, (error) => { cooldown.recordRateLimited(error.retryAfterHeader); });
  const app = buildApp({
    profileSource: source,
    render: stubRender,
    profileCache: false,
    now: () => nowMs,
    upstreamCooldown: cooldown,
  });
  try {
    // Avatar 429 is swallowed: the card still renders with a fallback image.
    const first = await postCard(app, 'alice');
    assert.equal(first.statusCode, 200);
    assert.equal(userCalls, 1);
    assert.equal(avatarCalls, 1);
    assert.equal(cooldown.isActive(), true);
    // The shared cooldown now short-circuits: no further source calls.
    const second = await postCard(app, 'bob');
    assert.equal(second.statusCode, 429);
    assert.equal(second.json().error.code, 'upstream_rate_limited');
    assert.equal(userCalls, 1);
    assert.equal(avatarCalls, 1);
  } finally {
    await app.close();
  }
});

test('MisskeyClient preserves Retry-After on user-info and avatar 429s over real HTTP', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/api/users/show') {
      res.writeHead(429, { 'retry-after': '7' });
      res.end('{}');
    } else {
      res.writeHead(429, { 'retry-after': '9' });
      res.end('limited');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const client = new MisskeyClient({ baseUrl: origin, avatarAllowedOrigins: [origin] });
  const userError = await client.getUserInfo('@alice').then(
    () => assert.fail('expected getUserInfo to throw'),
    (error: unknown) => error,
  );
  assert.ok(userError instanceof MisskeyError);
  assert.equal(userError.kind, 'rate_limited');
  assert.equal(userError.retryAfterHeader, '7');
  const avatarError = await client.getAvatar({ avatarUrl: `${origin}/avatar.png` }).then(
    () => assert.fail('expected getAvatar to throw'),
    (error: unknown) => error,
  );
  assert.ok(avatarError instanceof MisskeyError);
  assert.equal(avatarError.kind, 'rate_limited');
  assert.equal(avatarError.retryAfterHeader, '9');
});

test('Retry-After parsing supports seconds and HTTP dates within bounds', () => {
  const nowMs = Date.parse('2026-01-01T00:00:00.000Z');
  assert.equal(parseRetryAfterMs('2', nowMs, 300_000), 2_000);
  assert.equal(parseRetryAfterMs('600', nowMs, 300_000), 300_000);
  assert.equal(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', nowMs, 300_000), 10_000);
  assert.equal(parseRetryAfterMs(null, nowMs, 300_000), undefined);
  assert.equal(parseRetryAfterMs('not-a-date', nowMs, 300_000), undefined);
});

test('retryAfterSeconds helper floors to at least 1 second', () => {
  assert.equal(retryAfterSeconds(0), 1);
  assert.equal(retryAfterSeconds(500), 1);
  assert.equal(retryAfterSeconds(2_000), 2);
});

test('profile cache bounds TTL and coalesces concurrent lookups with per-caller clones', async () => {
  let nowMs = 1_000_000;
  let calls = 0;
  const inner = {
    getProfile: async (username: string) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { username, displayName: 'Alice', notesCount: 0, avatar: Buffer.from('avatar-bytes') };
    },
  };
  const cached = new CachedProfileSource(inner, { ttlMs: 60_000, negativeTtlMs: 15_000, maxEntries: 200, maxAvatarBytes: 1024 * 1024 }, () => nowMs);
  const [first, second] = await Promise.all([cached.getProfile('@alice'), cached.getProfile('@ALICE ')]);
  assert.equal(first.displayName, 'Alice');
  assert.equal(second.displayName, 'Alice');
  assert.equal(calls, 1);
  // Coalesced callers get distinct buffers with equal content.
  assert.ok(first.avatar !== second.avatar);
  assert.ok(first.avatar?.equals(second.avatar ?? Buffer.alloc(0)));
  // Mutating one caller's copy leaves the other caller's copy intact.
  first.avatar?.fill(0);
  assert.ok(!second.avatar?.equals(first.avatar ?? Buffer.alloc(0)));
  // ... and does not poison the cache either.
  const third = await cached.getProfile('@alice');
  assert.ok(!third.avatar?.equals(first.avatar ?? Buffer.alloc(0)));
  assert.equal(calls, 1);
  // After TTL expiry the entry is refetched.
  nowMs += 61_000;
  await cached.getProfile('@alice');
  assert.equal(calls, 2);
});

test('profile cache evicts oldest entries under the entry-count bound', async () => {
  let calls = 0;
  const inner = {
    getProfile: async (username: string) => {
      calls += 1;
      return { username, displayName: username, notesCount: 0, avatar: Buffer.alloc(10, 1) };
    },
  };
  const cached = new CachedProfileSource(inner, { ttlMs: 60_000, negativeTtlMs: 0, maxEntries: 2, maxAvatarBytes: 1024 * 1024 }, Date.now);
  await cached.getProfile('@a');
  await cached.getProfile('@b');
  await cached.getProfile('@c');
  assert.equal(cached.size, 2);
  assert.equal(calls, 3);
  // '@a' was evicted oldest-first, so it misses and refetches.
  await cached.getProfile('@a');
  assert.equal(calls, 4);
});

test('profile cache evicts oldest entries under the avatar-byte bound', async () => {
  let calls = 0;
  const inner = {
    getProfile: async (username: string) => {
      calls += 1;
      return { username, displayName: username, notesCount: 0, avatar: Buffer.alloc(10, 1) };
    },
  };
  // 10-byte avatars against a 15-byte budget: only one entry fits.
  const cached = new CachedProfileSource(inner, { ttlMs: 60_000, negativeTtlMs: 0, maxEntries: 10, maxAvatarBytes: 15 }, Date.now);
  await cached.getProfile('@a');
  assert.equal(cached.size, 1);
  assert.equal(cached.cachedAvatarBytes, 10);
  await cached.getProfile('@b');
  assert.equal(cached.size, 1);
  assert.ok(cached.cachedAvatarBytes <= 15);
  assert.equal(calls, 2);
  // A single avatar larger than the whole budget is served but never stored.
  const huge = new CachedProfileSource(
    { getProfile: async (username: string) => ({ username, displayName: username, notesCount: 0, avatar: Buffer.alloc(64, 2) }) },
    { ttlMs: 60_000, negativeTtlMs: 0, maxEntries: 10, maxAvatarBytes: 32 },
    Date.now,
  );
  await huge.getProfile('@big');
  assert.equal(huge.size, 0);
});

test('negative not_found cache expires and can be disabled; other errors never cache', async () => {
  let nowMs = 0;
  let calls = 0;
  const missing = {
    getProfile: async (): Promise<never> => {
      calls += 1;
      throw new MisskeyError('not_found', 'gone');
    },
  };
  const cached = new CachedProfileSource(missing, { ttlMs: 60_000, negativeTtlMs: 15_000, maxEntries: 200, maxAvatarBytes: 1024 * 1024 }, () => nowMs);
  await assert.rejects(cached.getProfile('@ghost'), /gone/);
  await assert.rejects(cached.getProfile('@ghost'), /gone/);
  assert.equal(calls, 1);
  nowMs += 16_000;
  await assert.rejects(cached.getProfile('@ghost'), /gone/);
  assert.equal(calls, 2);

  let uncachedCalls = 0;
  const disabled = new CachedProfileSource(
    {
      getProfile: async (): Promise<never> => {
        uncachedCalls += 1;
        throw new MisskeyError('not_found', 'gone');
      },
    },
    { ttlMs: 60_000, negativeTtlMs: 0, maxEntries: 200, maxAvatarBytes: 1024 * 1024 },
    Date.now,
  );
  await assert.rejects(disabled.getProfile('@ghost'), /gone/);
  await assert.rejects(disabled.getProfile('@ghost'), /gone/);
  assert.equal(uncachedCalls, 2);

  let upstreamCalls = 0;
  const flaky = new CachedProfileSource(
    {
      getProfile: async (): Promise<never> => {
        upstreamCalls += 1;
        throw new MisskeyError('upstream', 'bad');
      },
    },
    { ttlMs: 60_000, negativeTtlMs: 15_000, maxEntries: 200, maxAvatarBytes: 1024 * 1024 },
    Date.now,
  );
  await assert.rejects(flaky.getProfile('@ghost'), /bad/);
  await assert.rejects(flaky.getProfile('@ghost'), /bad/);
  assert.equal(upstreamCalls, 2);
});

test('request-limits config validation rejects bad values and defaults empty env', () => {
  assert.throws(() => requestLimitsConfigFromEnv({ CARD_MAX_CONCURRENT: '0' } as NodeJS.ProcessEnv), /CARD_MAX_CONCURRENT/);
  assert.throws(() => requestLimitsConfigFromEnv({ CARD_MAX_CONCURRENT: 'NaN' } as NodeJS.ProcessEnv), /CARD_MAX_CONCURRENT/);
  assert.throws(() => requestLimitsConfigFromEnv({ CARD_UPSTREAM_COOLDOWN_MS: 'Infinity' } as NodeJS.ProcessEnv), /CARD_UPSTREAM_COOLDOWN_MS/);
  assert.throws(() => requestLimitsConfigFromEnv({ CARD_UPSTREAM_COOLDOWN_MAX_MS: '-1' } as NodeJS.ProcessEnv), /CARD_UPSTREAM_COOLDOWN_MAX_MS/);
  assert.deepEqual(requestLimitsConfigFromEnv({} as NodeJS.ProcessEnv), DEFAULT_REQUEST_LIMITS_CONFIG);
});

test('profile-cache config validation rejects bad values and defaults empty env', () => {
  assert.throws(() => profileCacheConfigFromEnv({ CARD_PROFILE_CACHE_TTL_MS: '0' } as NodeJS.ProcessEnv), /CARD_PROFILE_CACHE_TTL_MS/);
  assert.throws(() => profileCacheConfigFromEnv({ CARD_PROFILE_CACHE_TTL_MS: 'NaN' } as NodeJS.ProcessEnv), /CARD_PROFILE_CACHE_TTL_MS/);
  assert.throws(() => profileCacheConfigFromEnv({ CARD_PROFILE_CACHE_MAX_ENTRIES: '-3' } as NodeJS.ProcessEnv), /CARD_PROFILE_CACHE_MAX_ENTRIES/);
  assert.throws(() => profileCacheConfigFromEnv({ CARD_PROFILE_CACHE_MAX_AVATAR_BYTES: 'Infinity' } as NodeJS.ProcessEnv), /CARD_PROFILE_CACHE_MAX_AVATAR_BYTES/);
  // Negative TTL of 0 explicitly disables negative caching.
  assert.equal(profileCacheConfigFromEnv({ CARD_PROFILE_NEGATIVE_CACHE_TTL_MS: '0' } as NodeJS.ProcessEnv).negativeTtlMs, 0);
  assert.deepEqual(profileCacheConfigFromEnv({} as NodeJS.ProcessEnv), DEFAULT_PROFILE_CACHE_CONFIG);
});

test('removed IP/proxy env vars are ignored (no per-IP accounting)', () => {
  const config = requestLimitsConfigFromEnv({
    CARD_IP_RATE_LIMIT_MAX: '1',
    CARD_GLOBAL_RATE_LIMIT_MAX: '1',
    CARD_MAX_TRACKED_IPS: '10',
    CARD_TRUSTED_PROXIES: '10.0.0.1',
  } as unknown as NodeJS.ProcessEnv);
  assert.deepEqual(config, DEFAULT_REQUEST_LIMITS_CONFIG);
});

test('default safety stays conservative and cooldown records Retry-After', () => {
  assert.ok(DEFAULT_REQUEST_LIMITS_CONFIG.maxConcurrent <= 8);
  let nowMs = 0;
  const cooldown = new UpstreamCooldown(30_000, 300_000, () => nowMs);
  assert.equal(cooldown.isActive(), false);
  cooldown.recordRateLimited('2');
  assert.equal(cooldown.isActive(), true);
  assert.ok(cooldown.remainingSeconds() >= 2);
  nowMs += 3_000;
  assert.equal(cooldown.isActive(), false);
});
