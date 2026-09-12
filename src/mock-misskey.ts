import Fastify from 'fastify';
import sharp from 'sharp';

export function buildMockMisskey() {
  const app = Fastify({ logger: true });
  app.post('/api/users/show', async (request, reply) => {
    const body = (request.body ?? {}) as { username?: unknown; host?: unknown };
    if (body.host !== null && body.host !== undefined) return reply.code(400).send({ error: { code: 'INVALID_HOST', message: 'Only local users are supported.' } });
    if (body.username !== 'alice') return reply.code(404).send({ error: { code: 'NO_SUCH_USER', message: 'No such user.' } });
    return {
      id: 'mock-alice-id', username: 'alice', name: 'Alice', notesCount: 42,
      avatarUrl: `http://${request.headers.host ?? '127.0.0.1:4100'}/avatar.png`, unknownField: { preserved: true },
    };
  });
  app.get('/avatar.png', async (_request, reply) => {
    const image = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#7654f5' } }).png().toBuffer();
    return reply.type('image/png').send(image);
  });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildMockMisskey();
  await app.listen({ host: '127.0.0.1', port: Number(process.env.MOCK_MISSKEY_PORT ?? 4100) });
}
