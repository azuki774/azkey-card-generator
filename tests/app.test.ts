import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';

test('GET / returns the landing page', async () => {
  const app = buildApp();

  try {
    const response = await app.inject({ method: 'GET', url: '/' });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] ?? '', /^text\/html/);
    assert.match(response.body, /<title>azkey card generator<\/title>/);
  } finally {
    await app.close();
  }
});

test('GET /assets/styles.css returns the page stylesheet', async () => {
  const app = buildApp();

  try {
    const response = await app.inject({ method: 'GET', url: '/assets/styles.css' });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] ?? '', /^text\/css/);
    assert.ok(response.body.length > 0);
  } finally {
    await app.close();
  }
});
