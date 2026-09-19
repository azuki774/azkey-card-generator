/**
 * Server-side safety for card generation: a global concurrency cap and an
 * upstream 429 cooldown. All state is process-local and bounded.
 *
 * Deliberately no per-IP / global request counting and no proxy-trust
 * handling: repeated clicks are throttled by a UI-only cooldown in
 * `public/assets/app.js`, which direct API clients, reloads, and multiple
 * tabs can bypass. See `docs/security-request-limits.md`.
 */

export interface RequestLimitsConfig {
  /** Max concurrent profile-fetch + render pipelines. Immediate 429 when full. */
  maxConcurrent: number;
  /** Fallback upstream cooldown when Retry-After is missing/unparsable. */
  upstreamCooldownDefaultMs: number;
  /** Upper bound for any upstream cooldown delay. */
  upstreamCooldownMaxMs: number;
}

export const DEFAULT_REQUEST_LIMITS_CONFIG: RequestLimitsConfig = {
  maxConcurrent: 4,
  upstreamCooldownDefaultMs: 30_000,
  upstreamCooldownMaxMs: 300_000,
};

function parsePositiveInt(raw: string | undefined, name: string, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got ${JSON.stringify(raw)})`);
  }
  return value;
}

export function requestLimitsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RequestLimitsConfig {
  return {
    maxConcurrent: parsePositiveInt(env.CARD_MAX_CONCURRENT, 'CARD_MAX_CONCURRENT', 1, 64, DEFAULT_REQUEST_LIMITS_CONFIG.maxConcurrent),
    upstreamCooldownDefaultMs: parsePositiveInt(env.CARD_UPSTREAM_COOLDOWN_MS, 'CARD_UPSTREAM_COOLDOWN_MS', 1_000, 3_600_000, DEFAULT_REQUEST_LIMITS_CONFIG.upstreamCooldownDefaultMs),
    upstreamCooldownMaxMs: parsePositiveInt(env.CARD_UPSTREAM_COOLDOWN_MAX_MS, 'CARD_UPSTREAM_COOLDOWN_MAX_MS', 1_000, 3_600_000, DEFAULT_REQUEST_LIMITS_CONFIG.upstreamCooldownMaxMs),
  };
}

/** Bounded Retry-After parsing: seconds or HTTP-date, clamped to maxMs. */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number, maxMs: number): number | undefined {
  if (header == null) return undefined;
  const trimmed = header.trim();
  if (!trimmed || trimmed.length > 200) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds) || seconds < 0) return undefined;
    return Math.min(seconds * 1_000, maxMs);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - nowMs;
    if (diff <= 0) return undefined;
    return Math.min(diff, maxMs);
  }
  return undefined;
}

/** Seconds for a Retry-After header from ms (minimum 1). */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

/** Process-local cooldown set when upstream answers 429 (incl. swallowed avatar 429). */
export class UpstreamCooldown {
  private untilMs = 0;

  constructor(
    private readonly defaultMs: number = DEFAULT_REQUEST_LIMITS_CONFIG.upstreamCooldownDefaultMs,
    private readonly maxMs: number = DEFAULT_REQUEST_LIMITS_CONFIG.upstreamCooldownMaxMs,
    private readonly now: () => number = Date.now,
  ) {}

  recordRateLimited(retryAfterHeader?: string | null, explicitDelayMs?: number): number {
    const nowMs = this.now();
    const parsed = retryAfterHeader != null ? parseRetryAfterMs(retryAfterHeader, nowMs, this.maxMs) : undefined;
    let delay = explicitDelayMs ?? parsed ?? this.defaultMs;
    if (!Number.isFinite(delay) || delay <= 0) delay = this.defaultMs;
    delay = Math.min(Math.max(Math.floor(delay), 0), this.maxMs);
    if (delay <= 0) delay = this.defaultMs;
    this.untilMs = Math.max(this.untilMs, nowMs + delay);
    return delay;
  }

  isActive(atMs?: number): boolean {
    return this.remainingMs(atMs) > 0;
  }

  remainingMs(atMs?: number): number {
    const nowMs = atMs ?? this.now();
    return Math.max(0, this.untilMs - nowMs);
  }

  /** Ceiled seconds for the Retry-After header (minimum 1 while active). */
  remainingSeconds(atMs?: number): number {
    const remaining = this.remainingMs(atMs);
    if (remaining <= 0) return 0;
    return Math.max(1, Math.ceil(remaining / 1000));
  }

  reset(): void {
    this.untilMs = 0;
  }
}

/** Global concurrency gate: immediate rejection, no queue. Caller must release. */
export class ConcurrencyGate {
  private active = 0;

  constructor(private readonly max: number) {
    if (!Number.isSafeInteger(max) || max < 1) throw new Error('ConcurrencyGate max must be >= 1');
  }

  get activeCount(): number {
    return this.active;
  }

  get limit(): number {
    return this.max;
  }

  tryAcquire(): boolean {
    if (this.active >= this.max) return false;
    this.active += 1;
    return true;
  }

  release(): void {
    if (this.active > 0) this.active -= 1;
  }
}
