import Fastify, { type FastifyInstance } from 'fastify';

const runningMessage = 'azkey-card-generator is running';

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get('/', async (_request, reply) => reply.type('text/plain').send(runningMessage));

  return app;
}
