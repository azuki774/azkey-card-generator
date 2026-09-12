export const DEFAULT_MISSKEY_HOST = 'azkey.azuki.blue';

export function misskeyBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.MISSKEY_BASE_URL ?? `https://${DEFAULT_MISSKEY_HOST}`;
}
