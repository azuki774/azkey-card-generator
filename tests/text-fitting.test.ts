import assert from 'node:assert/strict';
import test from 'node:test';

import { fitText } from '../src/text-fitting.js';

const measureByGrapheme = async (text: string, size: number) =>
  [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(text)].length * size;
const measureByCodePoint = async (text: string, size: number) => [...text].length * size;

test('fitText keeps a short value at max size', async () => {
  assert.deepEqual(await fitText('Alice', { maxWidth: 100, maxSize: 10, minSize: 4 }, measureByGrapheme), { text: 'Alice', size: 10 });
});

test('fitText shrinks before adding an ellipsis', async () => {
  assert.deepEqual(await fitText('Alice', { maxWidth: 30, maxSize: 10, minSize: 4 }, measureByGrapheme), { text: 'Alice', size: 6 });
});

test('fitText truncates at the minimum size when the full value cannot fit', async () => {
  assert.deepEqual(await fitText('abcdef', { maxWidth: 10, maxSize: 4, minSize: 2 }, measureByGrapheme), { text: 'abcd…', size: 2 });
});

test('fitText normalizes whitespace', async () => {
  assert.deepEqual(await fitText('  A\n\tB  ', { maxWidth: 100, maxSize: 8, minSize: 2 }, measureByGrapheme), { text: 'A B', size: 8 });
  assert.deepEqual(await fitText(' \n\t ', { maxWidth: 100, maxSize: 8, minSize: 2 }, measureByGrapheme), { text: '', size: 8 });
});

for (const [label, cluster] of [['combining mark', 'e\u0301'], ['family emoji', '👩‍👩‍👧‍👦'], ['flag', '🇯🇵']] as const) {
  test(`fitText preserves the ${label} grapheme boundary`, async () => {
    assert.deepEqual(await fitText(`A${cluster}XYZ`, { maxWidth: 3, maxSize: 1, minSize: 1 }, measureByCodePoint), { text: 'A…', size: 1 });
  });
}
