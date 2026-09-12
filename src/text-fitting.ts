export type TextWidth = (text: string, size: number) => Promise<number>;

export interface TextFitOptions {
  maxWidth: number;
  maxSize: number;
  minSize: number;
}

function graphemes(value: string): string[] {
  return [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(value)].map(({ segment }) => segment);
}

export async function fitText(value: string, options: TextFitOptions, measure: TextWidth): Promise<{ text: string; size: number }> {
  const normalized = value.replace(/[\t\r\n]+/g, ' ').trim();
  if (!normalized) return { text: '', size: options.maxSize };

  const units = graphemes(normalized);
  for (let size = options.maxSize; size >= options.minSize; size -= 1) {
    if (await measure(normalized, size) <= options.maxWidth) return { text: normalized, size };
  }

  let text = '';
  for (const unit of units) {
    if (await measure(`${text}${unit}…`, options.minSize) > options.maxWidth) break;
    text += unit;
  }
  return { text: text ? `${text}…` : '…', size: options.minSize };
}
