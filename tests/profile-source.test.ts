import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { MisskeyProfileSource, profileFromMisskeyUser } from '../src/profile-source.js';
import { MisskeyClient } from '../src/misskey-client.js';
import { buildMockMisskey } from '../src/mock-misskey.js';
import { renderCards } from '../src/card-renderer.js';

test('profile mapping falls back from null, empty and whitespace names', () => {
  for (const name of [null, '', '   ']) {
    assert.deepEqual(profileFromMisskeyUser({ username: 'alice', name, notesCount: 3 }), { username: '@alice', displayName: 'alice', notesCount: 3 });
  }
  assert.equal(profileFromMisskeyUser({ username: 'alice', name: ' Alice ', notesCount: 3 }).displayName, 'Alice');
});

test('profile mapping carries optional user ID and registration date', () => {
  assert.deepEqual(profileFromMisskeyUser({
    id: 'misskey-user-id', username: 'alice', name: 'Alice', notesCount: 3,
    followingCount: 12, followersCount: 34,
    createdAt: '2024-05-06T07:08:09.000Z',
  }), {
    username: '@alice', displayName: 'Alice', notesCount: 3,
    followingCount: 12, followersCount: 34,
    userId: 'misskey-user-id', registrationDate: '2024-05-06T07:08:09.000Z',
  });
});

test('profile mapping omits absent, negative, fractional and unsafe social counts', () => {
  assert.deepEqual(profileFromMisskeyUser({
    username: 'alice', name: 'Alice', notesCount: 3,
    followingCount: -1, followersCount: Number.MAX_SAFE_INTEGER + 1,
  }), { username: '@alice', displayName: 'Alice', notesCount: 3 });
  assert.deepEqual(profileFromMisskeyUser({
    username: 'alice', name: 'Alice', notesCount: 3,
    followingCount: 1.5, followersCount: Number.NaN,
  }), { username: '@alice', displayName: 'Alice', notesCount: 3 });
});

test('profile mapping omits missing optional fields', () => {
  assert.deepEqual(profileFromMisskeyUser({ username: 'alice', name: 'Alice', notesCount: 3 }), {
    username: '@alice', displayName: 'Alice', notesCount: 3,
  });
});

function clientStub(overrides: Partial<Pick<MisskeyClient, 'getUserInfo' | 'getAvatar'>>): MisskeyClient {
  return overrides as MisskeyClient;
}

test('MisskeyProfileSource attaches a downloaded avatar to the profile', async () => {
  const avatar = Buffer.from('avatar');
  const source = new MisskeyProfileSource(clientStub({
    getUserInfo: async () => ({ id: 'id', username: 'alice', name: 'Alice', notesCount: 3, avatarUrl: 'https://example.test/avatar.png' }),
    getAvatar: async () => ({ data: avatar, contentType: 'image/png' }),
  }));
  const profile = await source.getProfile('@alice');
  assert.deepEqual(profile.avatar, avatar);
});

test('MisskeyProfileSource continues without an avatar when download returns null or fails', async () => {
  const user = { id: 'id', username: 'alice', name: 'Alice', notesCount: 3, avatarUrl: null };
  const nullSource = new MisskeyProfileSource(clientStub({ getUserInfo: async () => user, getAvatar: async () => null }));
  assert.equal((await nullSource.getProfile('alice')).avatar, undefined);

  const failedSource = new MisskeyProfileSource(clientStub({
    getUserInfo: async () => user,
    getAvatar: async () => { throw new Error('avatar unavailable'); },
  }));
  assert.equal((await failedSource.getProfile('alice')).avatar, undefined);
});

test('MisskeyProfileSource propagates user lookup failures', async () => {
  const error = new Error('user unavailable');
  const source = new MisskeyProfileSource(clientStub({
    getUserInfo: async () => { throw error; },
    getAvatar: async () => null,
  }));
  await assert.rejects(source.getProfile('alice'), error);
});

test('mock Misskey avatar flows through profile source into the rendered card', async () => {
  const mock = buildMockMisskey();
  await mock.listen({ host: '127.0.0.1', port: 0 });
  try {
    const address = mock.server.address();
    assert.ok(address && typeof address !== 'string');
    const client = new MisskeyClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const profile = await new MisskeyProfileSource(client).getProfile('@alice');
    assert.equal(profile.userId, 'mock-alice-id');
    assert.equal(profile.followingCount, 123);
    assert.equal(profile.followersCount, 456);
    assert.ok(profile.avatar);
    const cards = await renderCards(profile, new Date('2026-01-01T00:00:00.000Z'));
    const pixel = await sharp(cards.front).extract({ left: 224, top: 384, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.deepEqual([...pixel], [118, 84, 245]);
  } finally {
    await mock.close();
  }
});
