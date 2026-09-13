import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import sharp from 'sharp';

import type { Profile } from './profile-source.js';
import { fitText } from './text-fitting.js';

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 760;

export interface RenderedCards {
  front: Buffer;
  back: Buffer;
}

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const cardAssetsDirectory = resolve(sourceDirectory, '../assets/card-templates/default');
const fontFamily = 'Noto Sans CJK JP';
const FRONT = {
  title: { x: 64, y: 40, width: 800, size: 48, weight: 700, height: 64 }, logo: { x: 960, y: 40, size: 176 },
  avatar: { x: 64, y: 224, size: 320, radius: 24 }, panel: { x: 408, y: 200, width: 728, height: 368, radius: 24 },
  role: { x: 432, y: 224, width: 664, size: 32, minSize: 32, weight: 700, height: 48 }, name: { x: 432, y: 336, width: 664, size: 48, minSize: 24, weight: 800, height: 72 }, handle: { x: 432, y: 432, width: 664, size: 40, minSize: 24, weight: 700, height: 56 },
  userId: { x: 1136, y: 688, width: 704, size: 24, minSize: 16, weight: 500, height: 32 },
} as const;
const BACK = {
  title: { x: 64, y: 40, width: 800, size: 48, weight: 700 }, logo: { x: 960, y: 40, size: 176 },
  notesLabel: { x: 108, y: 290, width: 360, size: 26, minSize: 24, weight: 700 }, notes: { x: 108, y: 338, width: 420, size: 34, minSize: 24, weight: 800 },
  registrationLabel: { x: 108, y: 454, width: 360, size: 26, minSize: 24, weight: 700 }, registration: { x: 108, y: 502, width: 420, size: 34, minSize: 24, weight: 800 },
  handle: { x: 1136, y: 656, width: 704, size: 22, minSize: 16, weight: 500 },
  userId: { x: 1136, y: 696, width: 704, size: 18, minSize: 14, weight: 500 },
} as const;

function escapeXml(value: string): string {
  return value.replace(/[<>&'\"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[character] ?? character));
}

function formatRegistrationDate(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(0, 10);
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
  const fitted = await fitText(value, { maxWidth: width, maxSize, minSize }, (text, size) => renderedWidth(text, size, weight));
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

async function backSvg(profile: Profile): Promise<Buffer> {
  const [title, logo, notesLabel, notes, registrationLabel, registration, handle, userId] = await Promise.all([
    textElement('Azuki Internet', BACK.title.x, BACK.title.y, BACK.title.width, BACK.title.size, BACK.title.size, BACK.title.weight),
    readFile(resolve(cardAssetsDirectory, 'front/icons/placeholder.svg')),
    textElement('ノート数', BACK.notesLabel.x, BACK.notesLabel.y, BACK.notesLabel.width, BACK.notesLabel.size, BACK.notesLabel.minSize, BACK.notesLabel.weight),
    textElement(profile.notesCount.toLocaleString('en-US'), BACK.notes.x, BACK.notes.y, BACK.notes.width, BACK.notes.size, BACK.notes.minSize, BACK.notes.weight),
    textElement('登録日', BACK.registrationLabel.x, BACK.registrationLabel.y, BACK.registrationLabel.width, BACK.registrationLabel.size, BACK.registrationLabel.minSize, BACK.registrationLabel.weight),
    textElement(formatRegistrationDate(profile.registrationDate), BACK.registration.x, BACK.registration.y, BACK.registration.width, BACK.registration.size, BACK.registration.minSize, BACK.registration.weight),
    textElement(`@${profile.username.replace(/^@/, '')}`, BACK.handle.x, BACK.handle.y, BACK.handle.width, BACK.handle.size, BACK.handle.minSize, BACK.handle.weight, 'end'),
    profile.userId?.trim() ? textElement(profile.userId, BACK.userId.x, BACK.userId.y, BACK.userId.width, BACK.userId.size, BACK.userId.minSize, BACK.userId.weight, 'end') : Promise.resolve(''),
  ]);
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
  ${title}
  <image x="${BACK.logo.x}" y="${BACK.logo.y}" width="${BACK.logo.size}" height="${BACK.logo.size}" href="data:image/svg+xml;base64,${logo.toString('base64')}"/>
  ${notesLabel}${notes}${registrationLabel}${registration}${handle}${userId}
</svg>`);
}

async function renderSide(profile: Profile, side: 'front' | 'back'): Promise<Buffer> {
  const basePath = resolve(cardAssetsDirectory, side === 'back' ? 'front' : side, 'base.png');
  const overlay = side === 'front' ? await frontSvg(profile) : await backSvg(profile);
  return sharp(basePath).composite([{ input: overlay }]).png().toBuffer();
}

export async function renderCards(profile: Profile, generatedAt: Date): Promise<RenderedCards> {
  const [front, back] = await Promise.all([renderSide(profile, 'front'), renderSide(profile, 'back')]);
  return { front, back };
}
