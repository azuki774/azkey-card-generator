import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { buildApp } from '../src/app.js';

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
    const actualCrc = png.readUInt32BE(dataEnd);
    assert.equal(actualCrc, crc32(Buffer.concat([typeBytes, data])), `invalid CRC for ${typeBytes.toString('ascii')}`);
    chunks.push({ type: typeBytes.toString('ascii'), data });
    offset = crcEnd;
  }

  assert.equal(offset, png.length);
  assert.deepEqual(chunks.map(({ type }) => type), ['IHDR', 'IDAT', 'IEND']);
  const header = chunks[0].data;
  assert.equal(header.length, 13);
  assert.equal(header.readUInt8(8), 8, 'PNG must use 8-bit samples');
  assert.equal(header.readUInt8(9), 2, 'PNG must use RGB color');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const pixels = inflateSync(chunks[1].data);
  assert.equal(pixels.length, (width * 3 + 1) * height, 'PNG scanline data has an unexpected length');
  for (let y = 0; y < height; y += 1) {
    assert.equal(pixels[y * (width * 3 + 1)], 0, 'PNG uses an unsupported row filter');
  }

  return { width, height, pixels };
}

test('GET / returns the landing page', async () => {
  const app = buildApp();

  try {
    const response = await app.inject({ method: 'GET', url: '/' });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] ?? '', /^text\/html/);
    assert.match(response.body, /<title>azkey card generator<\/title>/);
    assert.match(response.body, /カードプレビュー（表裏）/);
    assert.match(response.body, /表面.*FRONT/s);
    assert.match(response.body, /裏面.*BACK/s);
    assert.equal((response.body.match(/class="download-button"/g) ?? []).length, 2);
    assert.equal((response.body.match(/disabled aria-label="[^\"]*PNGでダウンロード/g) ?? []).length, 2);
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

  assert.notDeepEqual(decodedImages[0].pixels, decodedImages[1].pixels, 'front and back bases should be distinct');
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
