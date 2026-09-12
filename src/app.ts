import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import ejs from 'ejs';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderCards, type RenderedCards } from './card-renderer.js';
import { PlaceholderProfileSource, type Profile, type ProfileSource } from './profile-source.js';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const templatesDirectory = resolve(sourceDirectory, '../templates');
const publicDirectory = resolve(sourceDirectory, '../public/assets');

export interface BuildAppOptions {
  profileSource?: ProfileSource;
  render?: (profile: Profile, generatedAt: Date) => Promise<RenderedCards>;
  now?: () => number;
}

interface CardFormBody {
  username?: unknown;
}

interface ErrorResponse {
  error: {
    code: 'invalid_username' | 'image_generation_failed';
    message: string;
  };
}

const usernamePattern = /^@[A-Za-z0-9_]{1,20}$/;

function normalizeUsername(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

function sendError(reply: FastifyReply, statusCode: 400 | 500, error: ErrorResponse['error']) {
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

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  const now = options.now ?? Date.now;
  const profileSource = options.profileSource ?? new PlaceholderProfileSource();
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
        message: 'ユーザー名は英数字・アンダースコアの1〜20文字で入力してください。',
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
      return sendError(reply, 500, {
        code: 'image_generation_failed',
        message: 'カード画像を生成できませんでした。時間をおいて再度お試しください。',
      });
    }
  });

  return app;
}
