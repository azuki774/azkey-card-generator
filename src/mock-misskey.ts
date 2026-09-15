import Fastify from 'fastify';
import sharp from 'sharp';

const longDisplayName = '長い表示名'.repeat(20);
const longIdUsername = 'long_account_'.repeat(20);
const longBothUsername = 'long_both_'.repeat(20);

const users = new Map([
  ['alice', { id: 'mock-alice-id', username: 'alice', name: 'Alice' }],
  ['longname', { id: 'mock-longname-id', username: 'longname', name: longDisplayName }],
  ['longid', { id: 'mock-longid-id', username: longIdUsername, name: 'Alice' }],
  ['longboth', { id: 'mock-longboth-id', username: longBothUsername, name: longDisplayName }],
  [longIdUsername, { id: 'mock-longid-id', username: longIdUsername, name: 'Alice' }],
  [longBothUsername, { id: 'mock-longboth-id', username: longBothUsername, name: longDisplayName }],
]);

export function buildMockMisskey() {
  const app = Fastify({ logger: true });
  app.post('/api/users/show', async (request, reply) => {
    const body = (request.body ?? {}) as { username?: unknown; host?: unknown };
    if (body.host !== null && body.host !== undefined) return reply.code(400).send({ error: { code: 'INVALID_HOST', message: 'Only local users are supported.' } });
    const user = typeof body.username === 'string' ? users.get(body.username) : undefined;
    if (!user) return reply.code(404).send({ error: { code: 'NO_SUCH_USER', message: 'No such user.' } });
    return {
      ...user, notesCount: 42, followingCount: 123, followersCount: 456, createdAt: '2020-02-03T04:05:06.000Z',
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
  await app.listen({ host: process.env.MOCK_MISSKEY_HOST ?? '0.0.0.0', port: Number(process.env.MOCK_MISSKEY_PORT ?? 4100) });
}
