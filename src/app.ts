import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import ejs from 'ejs';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderCards, type RenderedCards } from './card-renderer.js';
import { guardCrossSiteCardsRequest } from './cross-site-guard.js';
import { type Profile, type ProfileSource } from './profile-source.js';
import { MisskeyError } from './misskey-client.js';
import {
  ConcurrencyGate,
  DEFAULT_REQUEST_LIMITS_CONFIG,
  UpstreamCooldown,
  retryAfterSeconds,
  type RequestLimitsConfig,
} from './request-limits.js';
import { CachedProfileSource, DEFAULT_PROFILE_CACHE_CONFIG, type ProfileCacheConfig } from './profile-cache.js';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const templatesDirectory = resolve(sourceDirectory, '../templates');
const publicDirectory = resolve(sourceDirectory, '../public/assets');

export interface BuildAppOptions {
  profileSource: ProfileSource;
  render?: (profile: Profile, generatedAt: Date) => Promise<RenderedCards>;
  now?: () => number;
  /** Partial overrides for concurrency/upstream-cooldown safety. `false` disables both guards. */
  requestLimits?: Partial<RequestLimitsConfig> | false;
  /** Partial overrides for the profile/avatar cache. `false` disables caching. */
  profileCache?: Partial<ProfileCacheConfig> | false;
  /** Shared collaborators (tests / server wiring). Created from config when omitted. */
  concurrencyGate?: ConcurrencyGate;
  upstreamCooldown?: UpstreamCooldown;
}

interface CardFormBody {
  username?: unknown;
}

interface ErrorResponse {
  error: {
    code: 'invalid_username' | 'image_generation_failed' | 'user_not_found' | 'upstream_rate_limited' | 'profile_source_failed' | 'profile_source_timeout' | 'rate_limited';
    message: string;
  };
}

const usernamePattern = /^@[A-Za-z0-9_]{1,100}$/;
/** Small Retry-After for an occupied concurrency gate (no queue, immediate 429). */
const CONCURRENCY_RETRY_AFTER_SECONDS = 2;

function normalizeUsername(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

function sendError(reply: FastifyReply, statusCode: number, error: ErrorResponse['error']) {
  return reply
    .code(statusCode)
    .type('application/json')
    .header('Cache-Control', 'no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .send({ error } satisfies ErrorResponse);
}

function sendRateLimited(reply: FastifyReply, code: ErrorResponse['error']['code'], message: string, retryAfterSecondsValue: number) {
  return reply
    .code(429)
    .type('application/json')
    .header('Cache-Control', 'no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Retry-After', String(Math.max(1, Math.ceil(retryAfterSecondsValue))))
    .send({ error: { code, message } } satisfies ErrorResponse);
}

function serializeCard(image: Buffer, fileName: string) {
  return {
    data: image.toString('base64'),
    mediaType: 'image/png' as const,
    fileName,
  };
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const limitsConfig: RequestLimitsConfig | null =
    options.requestLimits === false
      ? null
      : { ...DEFAULT_REQUEST_LIMITS_CONFIG, ...options.requestLimits };
  const cacheConfig: ProfileCacheConfig | null =
    options.profileCache === false
      ? null
      : { ...DEFAULT_PROFILE_CACHE_CONFIG, ...options.profileCache };
  // No trustProxy interpretation: default Fastify behavior (raw socket IP,
  // no X-Forwarded-For handling). No per-IP accounting is performed.
  const app = Fastify({ logger: true });
  const now = options.now ?? Date.now;
  const render = options.render ?? renderCards;

  const gate =
    options.concurrencyGate ??
    (limitsConfig ? new ConcurrencyGate(limitsConfig.maxConcurrent) : null);
  const cooldown =
    options.upstreamCooldown ??
    (limitsConfig ? new UpstreamCooldown(limitsConfig.upstreamCooldownDefaultMs, limitsConfig.upstreamCooldownMaxMs, now) : null);

  // Bounded short-TTL profile/avatar cache. Rendered cards are never cached:
  const profileSource: ProfileSource =
    cacheConfig && !(options.profileSource instanceof CachedProfileSource)
      ? new CachedProfileSource(options.profileSource, cacheConfig, now)
      : options.profileSource;

  function recordUpstreamRateLimited(error: MisskeyError): number {
    if (!cooldown) return 0;
    return cooldown.recordRateLimited(error.retryAfterHeader);
  }

  app.register(fastifyView, {
    engine: { ejs },
    root: templatesDirectory,
  });
  app.addHook('preHandler', guardCrossSiteCardsRequest);
  app.register(fastifyStatic, {
    root: publicDirectory,
    prefix: '/assets/',
    cacheControl: false,
    setHeaders(reply) {
      reply.header('Cache-Control', 'no-cache');
    },
  });
  app.register(fastifyFormbody);

  app.get('/', async (_request, reply) => reply.header('Cache-Control', 'no-cache').viewAsync('index.ejs'));

  app.post('/cards', async (request, reply) => {
    const body = (request.body ?? {}) as CardFormBody;
    const username = normalizeUsername(body.username);
    if (!usernamePattern.test(username)) {
      return sendError(reply, 400, {
        code: 'invalid_username',
        message: 'ユーザー名を確認してください。使用できる文字は英数字・アンダースコアです。',
      });
    }

    // Upstream cooldown first: do not hit Misskey/avatar servers while cooling.
    if (cooldown?.isActive()) {
      return sendRateLimited(
        reply,
        'upstream_rate_limited',
        'アクセスが集中しています。時間をおいて再度お試しください。',
        cooldown.remainingSeconds(),
      );
    }

    // Global concurrency cap spans profile fetch through rendering.
    // No queue: reject immediately so slow upstreams cannot pile up work.
    // This is overload safety, not per-client abuse protection.
    if (gate && !gate.tryAcquire()) {
      return sendRateLimited(
        reply,
        'rate_limited',
        'サーバーが混み合っています。時間をおいて再度お試しください。',
        CONCURRENCY_RETRY_AFTER_SECONDS,
      );
    }

    try {
      const profile = await profileSource.getProfile(username);
      const generatedAt = new Date(now());
      const cards = await render(profile, generatedAt);

      return reply
        .type('application/json')
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send({
          generatedAt: generatedAt.toISOString(),
          cards: {
            front: serializeCard(cards.front, `front-azkcard-${cards.cardId}.png`),
            back: serializeCard(cards.back, `back-azkcard-${cards.cardId}.png`),
          },
        });
    } catch (error) {
      request.log.error(error, 'failed to generate card images');
      if (error instanceof MisskeyError) {
        if (error.kind === 'not_found') return sendError(reply, 404, { code: 'user_not_found', message: 'ユーザーが見つかりませんでした。' });
        if (error.kind === 'rate_limited') {
          const delayMs = recordUpstreamRateLimited(error);
          const retryAfter = cooldown
            ? cooldown.remainingSeconds()
            : retryAfterSeconds(delayMs);
          return sendRateLimited(
            reply,
            'upstream_rate_limited',
            'アクセスが集中しています。時間をおいて再度お試しください。',
            retryAfter,
          );
        }
        if (error.kind === 'timeout') return sendError(reply, 504, { code: 'profile_source_timeout', message: 'プロフィールの取得がタイムアウトしました。時間をおいて再度お試しください。' });
        if (error.kind === 'upstream' || error.kind === 'invalid_response') return sendError(reply, 502, { code: 'profile_source_failed', message: 'プロフィールを取得できませんでした。時間をおいて再度お試しください。' });
      }
      return sendError(reply, 500, {
        code: 'image_generation_failed',
        message: 'カード画像を生成できませんでした。時間をおいて再度お試しください。',
      });
    } finally {
      gate?.release();
    }
  });

  return app;
}
