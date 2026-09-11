import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import type { Profile } from './profile-source.js';

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 760;

export interface RenderedCards {
  front: Buffer;
  back: Buffer;
}

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const cardAssetsDirectory = resolve(sourceDirectory, '../assets/card-templates/default');

function escapeXml(value: string): string {
  return value.replace(/[<>&'\"]/g, (character) => {
    switch (character) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case "'": return '&apos;';
      case '"': return '&quot;';
      default: return character;
    }
  });
}

function formatDate(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function overlaySvg(profile: Profile, generatedAt: Date, side: 'front' | 'back'): Buffer {
  const username = escapeXml(profile.username.replace(/^@/, ''));
  const displayName = escapeXml(profile.displayName);
  const notesCount = escapeXml(profile.notesCount.toLocaleString('en-US'));
  const generatedAtLabel = escapeXml(formatDate(generatedAt));
  const accent = side === 'front' ? '#7654f5' : '#2daeb5';

  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
  <text x="64" y="78" fill="${accent}" font-family="Noto Sans CJK JP, DejaVu Sans, sans-serif" font-size="25" font-weight="700" letter-spacing="4">AZKEY PROFILE CARD · ${side.toUpperCase()}</text>
  <circle cx="600" cy="340" r="72" fill="#ffffff" opacity="0.94"/>
  <path d="M482 494c30-92 206-92 236 0" fill="#ffffff" opacity="0.94"/>
  <rect x="250" y="535" width="700" height="150" rx="28" fill="#ffffff" opacity="0.92"/>
  <text x="600" y="594" text-anchor="middle" fill="#242032" font-family="Noto Sans CJK JP, DejaVu Sans, sans-serif" font-size="42" font-weight="800">${displayName}</text>
  <text x="600" y="642" text-anchor="middle" fill="${accent}" font-family="Noto Sans CJK JP, DejaVu Sans, sans-serif" font-size="27" font-weight="700">@${username}</text>
  <text x="64" y="724" fill="#777184" font-family="Noto Sans CJK JP, DejaVu Sans, sans-serif" font-size="20">公開ノート ${notesCount}</text>
  <text x="1136" y="724" text-anchor="end" fill="#777184" font-family="Noto Sans CJK JP, DejaVu Sans, sans-serif" font-size="20">${generatedAtLabel}</text>
</svg>`);
}

async function renderSide(profile: Profile, generatedAt: Date, side: 'front' | 'back'): Promise<Buffer> {
  const basePath = resolve(cardAssetsDirectory, side, 'base.png');
  return sharp(basePath)
    .composite([{ input: overlaySvg(profile, generatedAt, side) }])
    .png()
    .toBuffer();
}

/** Render both sides from the replaceable template assets supplied by the design task. */
export async function renderCards(profile: Profile, generatedAt: Date): Promise<RenderedCards> {
  const [front, back] = await Promise.all([
    renderSide(profile, generatedAt, 'front'),
    renderSide(profile, generatedAt, 'back'),
  ]);
  return { front, back };
}
