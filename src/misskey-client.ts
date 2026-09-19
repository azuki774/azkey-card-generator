import sharp from 'sharp';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_JSON_BYTES = 1_024 * 1_024;
const MAX_AVATAR_BYTES = 5 * 1_024 * 1_024;
// Rendered avatar slot is 320x320px (102_400 pixels). 4M pixels (~39x the
// output area) leaves ample headroom for cover-crop quality while bounding
// 8-bit RGBA pixel data to ~16MB (4M * 4 bytes), versus ~100MB at
// the previous 25M pixel limit. The compressed download cap below is
// intentionally unchanged: this limit bounds *decoded dimensions*, which a
// small compressed file can still exceed.
export const MAX_INPUT_PIXELS = 4_000_000;
export const AVATAR_SIZE_PX = 320;
// Native (libvips) per-image processing bound supported by the installed
// sharp (`pipeline.timeout()`). This is a best-effort processing guard, not
// a hard end-to-end deadline or a memory bound:
// resizing does not eliminate decoder working memory (see
// docs/security-avatar-memory.md).
export const AVATAR_PROCESS_TIMEOUT_SECONDS = 5;
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export interface MisskeyUserInfo {
  id: string;
  username: string;
  name: string | null;
  notesCount: number;
  followingCount?: number;
  followersCount?: number;
  createdAt?: string;
  avatarUrl: string | null;
  [key: string]: unknown;
}

export interface Avatar {
  data: Buffer;
  contentType: string;
}

export type MisskeyErrorKind = 'not_found' | 'rate_limited' | 'upstream' | 'invalid_response' | 'timeout' | 'avatar_rejected';

export class MisskeyError extends Error {
  constructor(public readonly kind: MisskeyErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MisskeyError';
  }
}

function boundedUrl(baseUrl: string): URL {
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch (error) {
    throw new TypeError('Misskey baseUrl must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('Misskey baseUrl must be an http(s) origin');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') throw new TypeError('Misskey baseUrl must not contain a path');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed;
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new MisskeyError('upstream', 'Response exceeded the configured size limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export class MisskeyClient {
  readonly baseUrl: URL;
  readonly avatarAllowedOrigins: ReadonlySet<string>;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl: string; avatarAllowedOrigins?: string[]; timeoutMs?: number }) {
    this.baseUrl = boundedUrl(options.baseUrl);
    const allowed = [this.baseUrl.origin, ...(options.avatarAllowedOrigins ?? [])].map((origin) => {
      const url = boundedUrl(origin);
      return url.origin;
    });
    this.avatarAllowedOrigins = new Set(allowed);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getUserInfo(username: string): Promise<MisskeyUserInfo> {
    const normalized = username.trim().replace(/^@/, '');
    if (!normalized) throw new MisskeyError('invalid_response', 'Username is empty');
    const { response, data: body } = await this.request('/api/users/show', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ username: normalized, host: null }),
    }, MAX_JSON_BYTES);
    if (!response.ok) {
      if (response.status === 404) throw new MisskeyError('not_found', 'Misskey user was not found');
      if (response.status === 429) throw new MisskeyError('rate_limited', 'Misskey rate limit exceeded');
      throw new MisskeyError('upstream', `Misskey returned HTTP ${response.status}`);
    }
    let value: unknown;
    try { value = JSON.parse(body.toString('utf8')); } catch (error) {
      throw new MisskeyError('invalid_response', 'Misskey returned invalid JSON', { cause: error });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MisskeyError('invalid_response', 'Misskey returned an invalid user object');
    const user = value as Record<string, unknown>;
    if (typeof user.id !== 'string' || typeof user.username !== 'string' || (user.name !== null && typeof user.name !== 'string') || typeof user.notesCount !== 'number' || !Number.isFinite(user.notesCount) || (user.avatarUrl !== null && typeof user.avatarUrl !== 'string')) {
      throw new MisskeyError('invalid_response', 'Misskey user object is missing required fields');
    }
    const normalizedUser = { ...user };
    for (const field of ['followingCount', 'followersCount'] as const) {
      const count = normalizedUser[field];
      if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) normalizedUser[field] = count;
      else delete normalizedUser[field];
    }
    return normalizedUser as MisskeyUserInfo;
  }

  async getAvatar(userInfo: Pick<MisskeyUserInfo, 'avatarUrl'>): Promise<Avatar | null> {
    if (!userInfo.avatarUrl) return null;
    let avatarUrl: URL;
    try { avatarUrl = new URL(userInfo.avatarUrl); } catch (error) {
      throw new MisskeyError('avatar_rejected', 'Avatar URL is invalid', { cause: error });
    }
    if ((avatarUrl.protocol !== 'http:' && avatarUrl.protocol !== 'https:') || avatarUrl.username || avatarUrl.password || !this.avatarAllowedOrigins.has(avatarUrl.origin)) {
      throw new MisskeyError('avatar_rejected', 'Avatar origin is not allowed');
    }
    const { response, data } = await this.request(avatarUrl.toString(), { method: 'GET', headers: { accept: [...AVATAR_TYPES].join(',') } }, MAX_AVATAR_BYTES);
    if (!response.ok) throw new MisskeyError('upstream', `Avatar returned HTTP ${response.status}`);
    const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
    if (!AVATAR_TYPES.has(contentType)) throw new MisskeyError('avatar_rejected', 'Avatar content type is not supported');
    try {
      // pages: 1 decodes only the first frame of animated inputs (GIF/WebP),
      // avoiding full-resolution output for every frame. Header/container
      // parsing still has a cost even for frames that are not rendered.
      // Channels are left as decoded (RGB/RGBA); the PNG encoder below
      // preserves alpha where present.
      const image = sharp(data, { limitInputPixels: MAX_INPUT_PIXELS, pages: 1 });
      const metadata = await image.metadata();
      const expectedFormat = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'image/gif': 'gif' }[contentType];
      if (!metadata.format || metadata.format !== expectedFormat) throw new Error('image format does not match content type');
      if (!metadata.width || !metadata.height) throw new Error('image dimensions are missing');
      // Belt-and-suspenders: limitInputPixels already rejects oversized inputs
      // at the metadata stage, but re-check explicitly so the bound holds even
      // if decoder metadata reporting changes.
      if (metadata.width * metadata.height > MAX_INPUT_PIXELS) throw new Error('image exceeds pixel limit');
      // Normalize to the exact bounded size the card renderer consumes, so no
      // full-resolution decode is retained or passed downstream. Center-cover
      // semantics match the renderer (320x320 cover, centred).
      const normalized = await image
        .timeout({ seconds: AVATAR_PROCESS_TIMEOUT_SECONDS })
        .resize(AVATAR_SIZE_PX, AVATAR_SIZE_PX, { fit: 'cover', position: 'centre' })
        .png()
        .toBuffer();
      return { data: normalized, contentType: 'image/png' };
    } catch (error) {
      throw new MisskeyError('avatar_rejected', 'Avatar is not a valid image', { cause: error });
    }
  }

  private async request(pathOrUrl: string, init: RequestInit, limit: number): Promise<{ response: Response; data: Buffer }> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : new URL(pathOrUrl, this.baseUrl).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
      const data = await readLimited(response, limit);
      return { response, data };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new MisskeyError('timeout', 'Misskey request timed out', { cause: error });
      if (error instanceof MisskeyError) throw error;
      throw new MisskeyError('upstream', 'Misskey request failed', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}
