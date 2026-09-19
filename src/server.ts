import { buildApp } from './app.js';
import { MisskeyClient, type MisskeyError } from './misskey-client.js';
import { misskeyBaseUrlFromEnv } from './misskey-config.js';
import { MisskeyProfileSource } from './profile-source.js';
import { profileCacheConfigFromEnv } from './profile-cache.js';
import { UpstreamCooldown, requestLimitsConfigFromEnv } from './request-limits.js';

const limits = requestLimitsConfigFromEnv();
const cooldown = new UpstreamCooldown(limits.upstreamCooldownDefaultMs, limits.upstreamCooldownMaxMs);
const onUpstreamRateLimited = (error: MisskeyError): void => {
  cooldown.recordRateLimited(error.retryAfterHeader);
};

const baseUrl = misskeyBaseUrlFromEnv();
const avatarAllowedOrigins = (process.env.MISSKEY_AVATAR_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
const client = new MisskeyClient({ baseUrl, avatarAllowedOrigins });
// Avatar 429 is swallowed inside the source (fallback image) but still cools
// down upstream via onUpstreamRateLimited; user-info 429 is additionally
// recorded by buildApp's catch path.
const profileSource = new MisskeyProfileSource(client, onUpstreamRateLimited);
const cache = profileCacheConfigFromEnv();
const app = buildApp({
  profileSource,
  requestLimits: limits,
  profileCache: cache,
  upstreamCooldown: cooldown,
});
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
