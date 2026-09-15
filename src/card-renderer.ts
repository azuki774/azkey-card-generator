import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import sharp from 'sharp';

import type { Profile } from './profile-source.js';
import { fitText } from './text-fitting.js';

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 760;

export interface RenderedCards {
  cardId: string;
  front: Buffer;
  back: Buffer;
}

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const cardAssetsDirectory = resolve(sourceDirectory, '../assets/card-templates/default');
const cardBackgroundPath = resolve(cardAssetsDirectory, 'front/base.png');
const fontFamily = 'Noto Sans CJK JP';
const FRONT = {
  title: { x: 64, y: 40, width: 800, size: 48, weight: 700, height: 64 }, logo: { x: 960, y: 40, size: 176 },
  avatar: { x: 64, y: 224, size: 320, radius: 24 }, panel: { x: 408, y: 200, width: 728, height: 368, radius: 24 },
  role: { x: 432, y: 224, width: 664, size: 32, minSize: 32, weight: 700, height: 48 }, name: { x: 432, y: 336, width: 664, size: 48, minSize: 36, weight: 800, height: 72 }, handle: { x: 432, y: 432, width: 664, size: 40, minSize: 32, weight: 700, height: 56 },
  issuedAt: { x: 1136, y: 656, width: 704, size: 16, minSize: 16, weight: 500 },
  cardId: { x: 1136, y: 696, width: 704, size: 16, minSize: 16, weight: 500 },
} as const;
const BACK = {
  title: { x: 64, y: 40, width: 800, size: 48, weight: 700 }, logo: { x: 960, y: 40, size: 176 },
  identity: { x: 108, y: 160, width: 800, nameWidth: 440, gap: 16, size: 28, minSize: 24, weight: 700 },
  notesLabel: { x: 108, y: 240, width: 360, size: 26, minSize: 24, weight: 700 }, notes: { x: 108, y: 282, width: 420, size: 34, minSize: 24, weight: 800 },
  issuedAt: { x: 1136, y: 656, width: 704, size: 16, minSize: 16, weight: 500 },
  cardId: { x: 1136, y: 696, width: 704, size: 16, minSize: 16, weight: 500 },
} as const;

function escapeXml(value: string): string {
  return value.replace(/[<>&'\"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[character] ?? character));
}

function formatIssuedAt(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function rasterText(value: string, size: number, weight: number, fill: string): Promise<{ data: string; width: number; height: number }> {
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

async function textElement(value: string, x: number, top: number, width: number, maxSize: number, minSize: number, weight: number, anchor = 'start', fill = '#242032'): Promise<string> {
  return (await textElementWithWidth(value, x, top, width, maxSize, minSize, weight, anchor, fill)).element;
}

async function textElementWithWidth(value: string, x: number, top: number, width: number, maxSize: number, minSize: number, weight: number, anchor = 'start', fill = '#242032'): Promise<{ element: string; width: number }> {
  const fitted = await fitText(value, { maxWidth: width, maxSize, minSize }, (text, size) => renderedWidth(text, size, weight));
  if (!fitted.text) return { element: '', width: 0 };
  const raster = await rasterText(fitted.text, fitted.size, weight, fill);
  const imageX = anchor === 'end' ? x - raster.width : x;
  return {
    element: `<image x="${imageX}" y="${top}" width="${raster.width}" height="${raster.height}" href="data:image/png;base64,${raster.data}"/>`,
    width: raster.width,
  };
}

async function identityElements(profile: Profile): Promise<string> {
  const name = await textElementWithWidth(
    profile.displayName,
    BACK.identity.x,
    BACK.identity.y,
    BACK.identity.nameWidth,
    BACK.identity.size,
    BACK.identity.minSize,
    BACK.identity.weight,
  );
  const gap = name.width > 0 ? BACK.identity.gap : 0;
  const handle = await textElementWithWidth(
    `@${profile.username.replace(/^@/, '')}`,
    BACK.identity.x + name.width + gap,
    BACK.identity.y,
    Math.max(BACK.identity.width - name.width - gap, 0),
    BACK.identity.size,
    BACK.identity.minSize,
    BACK.identity.weight,
    'start',
    '#7654f5',
  );
  return name.element + handle.element;
}

async function avatarData(profile: Profile): Promise<string> {
  const fallback = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="#eeeafa"/><circle cx="160" cy="130" r="62" fill="#7654f5" opacity=".65"/><path d="M50 300c28-92 192-92 220 0" fill="#7654f5" opacity=".65"/></svg>`);
  try {
    return (await sharp(profile.avatar ?? fallback).resize(320, 320, { fit: 'cover', position: 'centre' }).png().toBuffer()).toString('base64');
  } catch {
    return (await sharp(fallback).png().toBuffer()).toString('base64');
  }
}

async function frontSvg(profile: Profile, generatedAt: Date, cardId: string): Promise<Buffer> {
  const avatar = await avatarData(profile);
  const [title, role, displayName, username, issuedAt, cardIdText] = await Promise.all([
    textElement('Azuki Internet / PROFILE CARD', FRONT.title.x, FRONT.title.y, FRONT.title.width, FRONT.title.size, 28, FRONT.title.weight),
    profile.appRole?.trim() ? textElement(profile.appRole, FRONT.role.x, FRONT.role.y, FRONT.role.width, FRONT.role.size, FRONT.role.minSize, FRONT.role.weight) : Promise.resolve(''),
    textElement(profile.displayName, FRONT.name.x, FRONT.name.y, FRONT.name.width, FRONT.name.size, FRONT.name.minSize, FRONT.name.weight),
    textElement(`@${profile.username.replace(/^@/, '')}`, FRONT.handle.x, FRONT.handle.y, FRONT.handle.width, FRONT.handle.size, FRONT.handle.minSize, FRONT.handle.weight, 'start', '#7654f5'),
    textElement(formatIssuedAt(generatedAt), FRONT.issuedAt.x, FRONT.issuedAt.y, FRONT.issuedAt.width, FRONT.issuedAt.size, FRONT.issuedAt.minSize, FRONT.issuedAt.weight, 'end'),
    textElement(cardId, FRONT.cardId.x, FRONT.cardId.y, FRONT.cardId.width, FRONT.cardId.size, FRONT.cardId.minSize, FRONT.cardId.weight, 'end'),
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
  ${issuedAt}${cardIdText}
</svg>`);
}

function formatRegistrationDate(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(0, 10);
}

function formatCount(value: number | undefined): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value.toLocaleString('en-US') : '—';
}

async function backSvg(profile: Profile, generatedAt: Date, cardId: string): Promise<Buffer> {
  const statisticValues: ReadonlyArray<readonly [string, string]> = [
    ['ノート数', formatCount(profile.notesCount)],
    ['フォロー数', formatCount(profile.followingCount)],
    ['フォロワー数', formatCount(profile.followersCount)],
    ['登録日', formatRegistrationDate(profile.registrationDate)],
  ];
  const statistics = await Promise.all(statisticValues.map(async ([label, value], index) => {
    const offset = index * 96;
    const [heading, count] = await Promise.all([
      textElement(label, BACK.notesLabel.x, BACK.notesLabel.y + offset, BACK.notesLabel.width, BACK.notesLabel.size, BACK.notesLabel.minSize, BACK.notesLabel.weight),
      textElement(value, BACK.notes.x, BACK.notes.y + offset, BACK.notes.width, BACK.notes.size, BACK.notes.minSize, BACK.notes.weight),
    ]);
    return heading + count;
  }));
  const [title, identity, logo, issuedAt, cardIdText] = await Promise.all([
    textElement('Azuki Internet / PROFILE CARD', BACK.title.x, BACK.title.y, BACK.title.width, BACK.title.size, 28, BACK.title.weight),
    identityElements(profile),
    readFile(resolve(cardAssetsDirectory, 'front/icons/placeholder.svg')),
    textElement(formatIssuedAt(generatedAt), BACK.issuedAt.x, BACK.issuedAt.y, BACK.issuedAt.width, BACK.issuedAt.size, BACK.issuedAt.minSize, BACK.issuedAt.weight, 'end'),
    textElement(cardId, BACK.cardId.x, BACK.cardId.y, BACK.cardId.width, BACK.cardId.size, BACK.cardId.minSize, BACK.cardId.weight, 'end'),
  ]);
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
  ${title}
  <image x="${BACK.logo.x}" y="${BACK.logo.y}" width="${BACK.logo.size}" height="${BACK.logo.size}" href="data:image/svg+xml;base64,${logo.toString('base64')}"/>
  ${identity}${statistics.join('')}${issuedAt}${cardIdText}
</svg>`);
}

async function renderSide(profile: Profile, side: 'front' | 'back', generatedAt: Date, cardId: string): Promise<Buffer> {
  const overlay = side === 'front' ? await frontSvg(profile, generatedAt, cardId) : await backSvg(profile, generatedAt, cardId);
  return sharp(cardBackgroundPath).composite([{ input: overlay }]).png().toBuffer();
}

export async function renderCards(profile: Profile, generatedAt: Date, cardId: string = randomUUID()): Promise<RenderedCards> {
  const [front, back] = await Promise.all([renderSide(profile, 'front', generatedAt, cardId), renderSide(profile, 'back', generatedAt, cardId)]);
  return { front, back, cardId };
}
