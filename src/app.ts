import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import ejs from 'ejs';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderCards, type RenderedCards } from './card-renderer.js';
import { type Profile, type ProfileSource } from './profile-source.js';
import { MisskeyError } from './misskey-client.js';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const templatesDirectory = resolve(sourceDirectory, '../templates');
const publicDirectory = resolve(sourceDirectory, '../public/assets');

export interface BuildAppOptions {
  profileSource: ProfileSource;
  render?: (profile: Profile, generatedAt: Date) => Promise<RenderedCards>;
  now?: () => number;
}

interface CardFormBody {
  username?: unknown;
}

interface ErrorResponse {
  error: {
    code: 'invalid_username' | 'image_generation_failed' | 'user_not_found' | 'upstream_rate_limited' | 'profile_source_failed' | 'profile_source_timeout';
    message: string;
  };
}

const usernamePattern = /^@[A-Za-z0-9_]{1,100}$/;

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

function serializeCard(image: Buffer, fileName: string) {
  return {
    data: image.toString('base64'),
    mediaType: 'image/png' as const,
    fileName,
  };
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: true });
  const now = options.now ?? Date.now;
  const profileSource: ProfileSource = options.profileSource;
  const render = options.render ?? renderCards;

  app.register(fastifyView, {
    engine: { ejs },
    root: templatesDirectory,
  });
  app.register(fastifyStatic, {
    root: publicDirectory,
    prefix: '/assets/',
  });
  app.register(fastifyFormbody);

  app.get('/', async (_request, reply) => reply.viewAsync('index.ejs'));

  app.post('/cards', async (request, reply) => {
    const body = (request.body ?? {}) as CardFormBody;
    const username = normalizeUsername(body.username);
    if (!usernamePattern.test(username)) {
      return sendError(reply, 400, {
        code: 'invalid_username',
        message: 'ユーザー名を確認してください。使用できる文字は英数字・アンダースコアです。',
      });
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
            front: serializeCard(cards.front, 'azkey-card-front.png'),
            back: serializeCard(cards.back, 'azkey-card-back.png'),
          },
        });
    } catch (error) {
      request.log.error(error, 'failed to generate card images');
      if (error instanceof MisskeyError) {
        if (error.kind === 'not_found') return sendError(reply, 404, { code: 'user_not_found', message: 'ユーザーが見つかりませんでした。' });
        if (error.kind === 'rate_limited') return sendError(reply, 429, { code: 'upstream_rate_limited', message: 'アクセスが集中しています。時間をおいて再度お試しください。' });
        if (error.kind === 'timeout') return sendError(reply, 504, { code: 'profile_source_timeout', message: 'プロフィールの取得がタイムアウトしました。時間をおいて再度お試しください。' });
        if (error.kind === 'upstream' || error.kind === 'invalid_response') return sendError(reply, 502, { code: 'profile_source_failed', message: 'プロフィールを取得できませんでした。時間をおいて再度お試しください。' });
      }
      return sendError(reply, 500, {
        code: 'image_generation_failed',
        message: 'カード画像を生成できませんでした。時間をおいて再度お試しください。',
      });
    }
  });

  return app;
}
