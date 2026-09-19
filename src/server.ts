import { buildApp } from './app.js';
import { MisskeyClient } from './misskey-client.js';
import { misskeyBaseUrlFromEnv } from './misskey-config.js';
import { MisskeyProfileSource } from './profile-source.js';
import { loadRolesFromEnv, RoleConfigError } from './roles.js';

async function start(): Promise<void> {
  const appRoles = await loadRolesFromEnv();
  const baseUrl = misskeyBaseUrlFromEnv();
  const avatarAllowedOrigins = (process.env.MISSKEY_AVATAR_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const client = new MisskeyClient({ baseUrl, avatarAllowedOrigins });
  const app = buildApp({ profileSource: new MisskeyProfileSource(client, appRoles) });
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';

  try {
    await app.listen({ port, host });
  } catch (error) {
    app.log.error(error);
    throw error;
  }
}

try {
  await start();
} catch (error) {
  if (error instanceof RoleConfigError) {
    console.error(error.message);
  } else {
    console.error('server failed to start');
  }
  process.exitCode = 1;
}
