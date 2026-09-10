import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import ejs from 'ejs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const templatesDirectory = resolve(sourceDirectory, '../templates');
const publicDirectory = resolve(sourceDirectory, '../public/assets');

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.register(fastifyView, {
    engine: { ejs },
    root: templatesDirectory,
  });
  app.register(fastifyStatic, {
    root: publicDirectory,
    prefix: '/assets/',
  });

  app.get('/', async (_request, reply) => reply.viewAsync('index.ejs'));

  return app;
}
