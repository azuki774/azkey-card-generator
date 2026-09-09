import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';

test('GET / returns the running message', async () => {
  const app = buildApp();

  try {
    const response = await app.inject({ method: 'GET', url: '/' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'azkey-card-generator is running');
    assert.match(response.headers['content-type'] ?? '', /^text\/plain/);
  } finally {
    await app.close();
  }
});
