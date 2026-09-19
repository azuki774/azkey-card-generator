import type { Profile, ProfileSource } from './profile-source.js';
import { MisskeyError } from './misskey-client.js';

export interface ProfileCacheConfig {
  /** TTL for successful profile+avatar entries. */
  ttlMs: number;
  /** TTL for negative (not_found) entries; 0 disables negative caching. */
  negativeTtlMs: number;
  /** Max cached usernames (LRU eviction). */
  maxEntries: number;
  /** Max total cached avatar bytes (LRU eviction across oldest entries). */
  maxAvatarBytes: number;
}

export const DEFAULT_PROFILE_CACHE_CONFIG: ProfileCacheConfig = {
  ttlMs: 60_000,
  negativeTtlMs: 15_000,
  maxEntries: 200,
  maxAvatarBytes: 20 * 1024 * 1024,
};

function parsePositiveInt(raw: string | undefined, name: string, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got ${JSON.stringify(raw)})`);
  }
  return value;
}

export function profileCacheConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ProfileCacheConfig {
  return {
    ttlMs: parsePositiveInt(env.CARD_PROFILE_CACHE_TTL_MS, 'CARD_PROFILE_CACHE_TTL_MS', 1_000, 600_000, DEFAULT_PROFILE_CACHE_CONFIG.ttlMs),
    negativeTtlMs: parsePositiveInt(env.CARD_PROFILE_NEGATIVE_CACHE_TTL_MS, 'CARD_PROFILE_NEGATIVE_CACHE_TTL_MS', 0, 300_000, DEFAULT_PROFILE_CACHE_CONFIG.negativeTtlMs),
    maxEntries: parsePositiveInt(env.CARD_PROFILE_CACHE_MAX_ENTRIES, 'CARD_PROFILE_CACHE_MAX_ENTRIES', 1, 10_000, DEFAULT_PROFILE_CACHE_CONFIG.maxEntries),
    maxAvatarBytes: parsePositiveInt(env.CARD_PROFILE_CACHE_MAX_AVATAR_BYTES, 'CARD_PROFILE_CACHE_MAX_AVATAR_BYTES', 1024, 500 * 1024 * 1024, DEFAULT_PROFILE_CACHE_CONFIG.maxAvatarBytes),
  };
}

interface CacheEntry {
  profile?: Profile;
  notFound?: MisskeyError;
  expiresAt: number;
  avatarBytes: number;
}

function cacheKey(username: string): string {
  return username.trim().toLowerCase();
}

function avatarBytesOf(profile: Profile): number {
  return profile.avatar?.byteLength ?? 0;
}

function cloneProfile(profile: Profile): Profile {
  return { ...profile, avatar: profile.avatar ? Buffer.from(profile.avatar) : undefined };
}

/**
 * Bounded short-TTL cache around a ProfileSource with same-key request
 * coalescing. Only successful profiles and (optionally) not_found negatives
 * are cached; rendered cards are never cached so each issuance keeps a fresh
 * UUID/date. Memory is bounded by entry count AND total avatar bytes.
 */
export class CachedProfileSource implements ProfileSource {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<Profile>>();
  private avatarBytesTotal = 0;

  constructor(
    private readonly inner: ProfileSource,
    private readonly config: ProfileCacheConfig = DEFAULT_PROFILE_CACHE_CONFIG,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get cachedAvatarBytes(): number {
    return this.avatarBytesTotal;
  }

  clear(): void {
    this.entries.clear();
    this.avatarBytesTotal = 0;
  }

  async getProfile(username: string): Promise<Profile> {
    const key = cacheKey(username);
    const nowMs = this.now();
    this.evictExpired(nowMs);

    const cached = this.entries.get(key);
    if (cached) {
      // Refresh LRU order without extending TTL.
      this.entries.delete(key);
      this.entries.set(key, cached);
      if (cached.profile) return cloneProfile(cached.profile);
      if (cached.notFound) {
        throw new MisskeyError(cached.notFound.kind, cached.notFound.message);
      }
    }

    const pending = this.inFlight.get(key);
    if (pending) return cloneProfile(await pending);

    const task = this.inner.getProfile(username).then(
      (profile) => {
        this.storeSuccess(key, profile, this.now());
        return profile;
      },
      (error: unknown) => {
        if (error instanceof MisskeyError && error.kind === 'not_found' && this.config.negativeTtlMs > 0) {
          this.storeNegative(key, error, this.now());
        }
        throw error;
      },
    );
    this.inFlight.set(key, task);
    try {
      // Clone per caller: all coalesced awaiters share `task`, so a single
      // shared object here would let one caller mutate another's result.
      return cloneProfile(await task);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private removeEntry(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.avatarBytesTotal -= entry.avatarBytes;
    if (this.avatarBytesTotal < 0) this.avatarBytesTotal = 0;
  }

  private evictExpired(nowMs: number): void {
    // Single full sweep: entries are in LRU order, not expiry order, so an
    // early break could leave expired entries behind to grow unboundedly.
    // Deleting during Map iteration is safe.
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) this.removeEntry(key);
    }
  }

  private storeSuccess(key: string, profile: Profile, nowMs: number): void {
    const avatarBytes = avatarBytesOf(profile);
    // Strictly bound avatar memory: skip caching a profile whose single avatar
    // alone exceeds the byte budget.
    if (avatarBytes > this.config.maxAvatarBytes) return;
    // Replacing an existing key must release its bytes first, otherwise the
    // replaced entry's bytes leak into the total permanently.
    this.removeEntry(key);
    // Evict oldest until both bounds fit.
    while (this.entries.size >= this.config.maxEntries) {
      this.evictOldest();
    }
    while (this.avatarBytesTotal + avatarBytes > this.config.maxAvatarBytes && this.entries.size > 0) {
      this.evictOldest();
    }
    this.entries.set(key, {
      profile: cloneProfile(profile),
      expiresAt: nowMs + this.config.ttlMs,
      avatarBytes,
    });
    this.avatarBytesTotal += avatarBytes;
  }

  private storeNegative(key: string, error: MisskeyError, nowMs: number): void {
    this.removeEntry(key);
    while (this.entries.size >= this.config.maxEntries) {
      this.evictOldest();
    }
    this.entries.set(key, {
      notFound: new MisskeyError(error.kind, error.message),
      expiresAt: nowMs + this.config.negativeTtlMs,
      avatarBytes: 0,
    });
  }

  private evictOldest(): void {
    const oldest = this.entries.keys().next();
    if (oldest.done) return;
    this.removeEntry(oldest.value);
  }
}
