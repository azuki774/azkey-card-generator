import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

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
const fontFamily = 'Noto Sans CJK JP';
const backFontFamily = 'Noto Sans CJK JP, DejaVu Sans, sans-serif';
const FRONT = {
  title: { x: 64, y: 40, width: 800, size: 48, weight: 700, height: 64 }, logo: { x: 960, y: 40, size: 176 },
  avatar: { x: 64, y: 224, size: 320, radius: 24 }, panel: { x: 408, y: 200, width: 728, height: 368, radius: 24 },
  role: { x: 432, y: 224, width: 664, size: 32, minSize: 32, weight: 700, height: 48 }, name: { x: 432, y: 336, width: 664, size: 48, minSize: 24, weight: 800, height: 72 }, handle: { x: 432, y: 432, width: 664, size: 40, minSize: 24, weight: 700, height: 56 },
  userId: { x: 1136, y: 688, width: 704, size: 24, minSize: 16, weight: 500, height: 32 },
} as const;

function escapeXml(value: string): string {
  return value.replace(/[<>&'\"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[character] ?? character));
}

function formatDate(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function graphemes(value: string): string[] {
  return [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(value)].map(({ segment }) => segment);
}

export async function rasterText(value: string, size: number, weight: number, fill: string): Promise<{ data: string; width: number; height: number }> {
  const normalized = value.replace(/[\t\r\n]+/g, ' ').trim();
  if (!normalized) return { data: '', width: 0, height: 0 };
  const font = `${fontFamily} ${weight >= 700 ? 'Bold' : 'Regular'} ${size}`;
  const text = `<span foreground="${escapeXml(fill)}">${escapeXml(normalized)}</span>`;
  const { data, info } = await sharp({ text: { text, font, dpi: 72, rgba: true } }).png().toBuffer({ resolveWithObject: true });
  return { data: data.toString('base64'), width: info.width, height: info.height };
}

async function renderedWidth(value: string, size: number, weight: number): Promise<number> {
  return (await rasterText(value, size, weight, '#000')).width;
}

export async function fitText(value: string, maxWidth: number, maxSize: number, minSize: number, weight: number): Promise<{ text: string; size: number }> {
  const normalized = value.replace(/[\t\r\n]+/g, ' ').trim();
  if (!normalized) return { text: '', size: maxSize };
  const units = graphemes(normalized);
  for (let size = maxSize; size >= minSize; size -= 1) {
    if (await renderedWidth(normalized, size, weight) <= maxWidth) return { text: normalized, size };
  }
  let text = '';
  for (const unit of units) {
    if (await renderedWidth(`${text}${unit}…`, minSize, weight) > maxWidth) break;
    text += unit;
  }
  return { text: text ? `${text}…` : '…', size: minSize };
}

async function textElement(value: string, x: number, top: number, width: number, maxSize: number, minSize: number, weight: number, anchor = 'start', fill = '#242032'): Promise<string> {
  const fitted = await fitText(value, width, maxSize, minSize, weight);
  if (!fitted.text) return '';
  const raster = await rasterText(fitted.text, fitted.size, weight, fill);
  const imageX = anchor === 'end' ? x - raster.width : x;
  return `<image x="${imageX}" y="${top}" width="${raster.width}" height="${raster.height}" href="data:image/png;base64,${raster.data}"/>`;
}

async function avatarData(profile: Profile): Promise<string> {
  const fallback = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="#eeeafa"/><circle cx="160" cy="130" r="62" fill="#7654f5" opacity=".65"/><path d="M50 300c28-92 192-92 220 0" fill="#7654f5" opacity=".65"/></svg>`);
  try {
    return (await sharp(profile.avatar ?? fallback).resize(320, 320, { fit: 'cover', position: 'centre' }).png().toBuffer()).toString('base64');
  } catch {
    return (await sharp(fallback).png().toBuffer()).toString('base64');
  }
}

async function frontSvg(profile: Profile): Promise<Buffer> {
  const avatar = await avatarData(profile);
  const [title, role, displayName, username, userId] = await Promise.all([
    textElement('Azuki Internet', FRONT.title.x, FRONT.title.y, FRONT.title.width, FRONT.title.size, FRONT.title.size, FRONT.title.weight),
    profile.appRole?.trim() ? textElement(profile.appRole, FRONT.role.x, FRONT.role.y, FRONT.role.width, FRONT.role.size, FRONT.role.minSize, FRONT.role.weight) : Promise.resolve(''),
    textElement(profile.displayName, FRONT.name.x, FRONT.name.y, FRONT.name.width, FRONT.name.size, FRONT.name.minSize, FRONT.name.weight),
    textElement(`@${profile.username.replace(/^@/, '')}`, FRONT.handle.x, FRONT.handle.y, FRONT.handle.width, FRONT.handle.size, FRONT.handle.minSize, FRONT.handle.weight, 'start', '#7654f5'),
    profile.userId?.trim() ? textElement(profile.userId, FRONT.userId.x, FRONT.userId.y, FRONT.userId.width, FRONT.userId.size, FRONT.userId.minSize, FRONT.userId.weight, 'end') : Promise.resolve(''),
  ]);
  const logo = Buffer.from(await readFile(resolve(cardAssetsDirectory, 'front/icons/placeholder.svg'))).toString('base64');
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
  <defs><clipPath id="avatar-clip"><rect x="${FRONT.avatar.x}" y="${FRONT.avatar.y}" width="${FRONT.avatar.size}" height="${FRONT.avatar.size}" rx="${FRONT.avatar.radius}"/></clipPath></defs>
  <rect x="${FRONT.panel.x}" y="${FRONT.panel.y}" width="${FRONT.panel.width}" height="${FRONT.panel.height}" rx="${FRONT.panel.radius}" fill="#fff" opacity=".92"/>
  ${title}
  <image x="${FRONT.logo.x}" y="${FRONT.logo.y}" width="${FRONT.logo.size}" height="${FRONT.logo.size}" href="data:image/svg+xml;base64,${logo}"/>
  <image x="${FRONT.avatar.x}" y="${FRONT.avatar.y}" width="${FRONT.avatar.size}" height="${FRONT.avatar.size}" preserveAspectRatio="xMidYMid slice" href="data:image/png;base64,${avatar}" clip-path="url(#avatar-clip)"/>
  ${role}${displayName}${username}
  ${userId}
</svg>`);
}

function backSvg(profile: Profile, generatedAt: Date): Buffer {
  const username = escapeXml(profile.username.replace(/^@/, ''));
  const displayName = escapeXml(profile.displayName);
  const notesCount = escapeXml(profile.notesCount.toLocaleString('en-US'));
  const generatedAtLabel = escapeXml(formatDate(generatedAt));
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
  <text x="64" y="78" fill="#2daeb5" font-family="${backFontFamily}" font-size="25" font-weight="700" letter-spacing="4">AZKEY PROFILE CARD · BACK</text>
  <circle cx="600" cy="340" r="72" fill="#ffffff" opacity=".94"/><path d="M482 494c30-92 206-92 236 0" fill="#ffffff" opacity=".94"/>
  <rect x="250" y="535" width="700" height="150" rx="28" fill="#ffffff" opacity=".92"/>
  <text x="600" y="594" text-anchor="middle" fill="#242032" font-family="${backFontFamily}" font-size="42" font-weight="800">${displayName}</text>
  <text x="600" y="642" text-anchor="middle" fill="#2daeb5" font-family="${backFontFamily}" font-size="27" font-weight="700">@${username}</text>
  <text x="64" y="724" fill="#777184" font-family="${backFontFamily}" font-size="20">公開ノート ${notesCount}</text>
  <text x="1136" y="724" text-anchor="end" fill="#777184" font-family="${backFontFamily}" font-size="20">${generatedAtLabel}</text>
</svg>`);
}

async function renderSide(profile: Profile, generatedAt: Date, side: 'front' | 'back'): Promise<Buffer> {
  const basePath = resolve(cardAssetsDirectory, side, 'base.png');
  const overlay = side === 'front' ? await frontSvg(profile) : backSvg(profile, generatedAt);
  return sharp(basePath).composite([{ input: overlay }]).png().toBuffer();
}

export async function renderCards(profile: Profile, generatedAt: Date): Promise<RenderedCards> {
  const [front, back] = await Promise.all([renderSide(profile, generatedAt, 'front'), renderSide(profile, generatedAt, 'back')]);
  return { front, back };
}
