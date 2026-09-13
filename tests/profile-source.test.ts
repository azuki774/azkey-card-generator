import assert from 'node:assert/strict';
import test from 'node:test';
import { profileFromMisskeyUser } from '../src/profile-source.js';

test('profile mapping falls back from null, empty and whitespace names', () => {
  for (const name of [null, '', '   ']) {
    assert.deepEqual(profileFromMisskeyUser({ username: 'alice', name, notesCount: 3 }), { username: '@alice', displayName: 'alice', notesCount: 3 });
  }
  assert.equal(profileFromMisskeyUser({ username: 'alice', name: ' Alice ', notesCount: 3 }).displayName, 'Alice');
});

test('profile mapping carries optional user ID and registration date', () => {
  assert.deepEqual(profileFromMisskeyUser({
    id: 'misskey-user-id', username: 'alice', name: 'Alice', notesCount: 3,
    createdAt: '2024-05-06T07:08:09.000Z',
  }), {
    username: '@alice', displayName: 'Alice', notesCount: 3,
    userId: 'misskey-user-id', registrationDate: '2024-05-06T07:08:09.000Z',
  });
});

test('profile mapping omits missing optional fields', () => {
  assert.deepEqual(profileFromMisskeyUser({ username: 'alice', name: 'Alice', notesCount: 3 }), {
    username: '@alice', displayName: 'Alice', notesCount: 3,
  });
});
