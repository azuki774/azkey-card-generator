export interface Profile {
  username: string;
  displayName: string;
  notesCount: number;
  followingCount?: number;
  followersCount?: number;
  registrationDate?: string;
  appRole?: string;
  userId?: string;
  avatar?: Buffer;
}

export interface ProfileSource {
  getProfile(username: string): Promise<Profile>;
}

import { MisskeyClient, MisskeyError, type MisskeyUserInfo } from './misskey-client.js';

export class MisskeyProfileSource implements ProfileSource {
  constructor(
    private readonly client: MisskeyClient,
    private readonly onUpstreamRateLimited?: (error: MisskeyError) => void,
  ) {}

  private notifyRateLimited(error: unknown): void {
    if (error instanceof MisskeyError && error.kind === 'rate_limited') {
      try {
        this.onUpstreamRateLimited?.(error);
      } catch {
        // Cooldown bookkeeping must never break profile delivery.
      }
    }
  }

  async getProfile(username: string): Promise<Profile> {
    let user;
    try {
      user = await this.client.getUserInfo(username);
    } catch (error) {
      this.notifyRateLimited(error);
      throw error;
    }
    const profile = profileFromMisskeyUser(user);
    try {
      const avatar = await this.client.getAvatar(user);
      if (avatar) profile.avatar = avatar.data;
    } catch (error) {
      // Avatar 429 still cools down upstream even though the profile itself
      // is served with the renderer's fallback image.
      this.notifyRateLimited(error);
      // Other avatar failures use the renderer's fallback without losing the profile.
    }
    return profile;
  }
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function profileFromMisskeyUser(user: Pick<MisskeyUserInfo, 'username' | 'name' | 'notesCount'> & Partial<Pick<MisskeyUserInfo, 'id' | 'createdAt' | 'followingCount' | 'followersCount'>>): Profile {
  const displayName = user.name?.trim() || user.username;
  const profile: Profile = {
    username: `@${user.username.replace(/^@/, '')}`,
    displayName,
    notesCount: user.notesCount,
  };
  const followingCount = optionalCount(user.followingCount);
  const followersCount = optionalCount(user.followersCount);
  if (followingCount !== undefined) profile.followingCount = followingCount;
  if (followersCount !== undefined) profile.followersCount = followersCount;
  if (typeof user.id === 'string' && user.id.trim()) profile.userId = user.id;
  if (typeof user.createdAt === 'string') profile.registrationDate = user.createdAt;
  return profile;
}
