import assert from 'node:assert/strict';
import test from 'node:test';
import { profileFromMisskeyUser } from '../src/profile-source.js';

test('profile mapping falls back from null, empty and whitespace names', () => {
  for (const name of [null, '', '   ']) {
    assert.deepEqual(profileFromMisskeyUser({ username: 'alice', name, notesCount: 3 }), { username: '@alice', displayName: 'alice', notesCount: 3 });
  }
  assert.equal(profileFromMisskeyUser({ username: 'alice', name: ' Alice ', notesCount: 3 }).displayName, 'Alice');
});
