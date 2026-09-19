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

import { MisskeyClient, type MisskeyUserInfo } from './misskey-client.js';
import { normalizeRoleUsername } from './roles.js';

export class MisskeyProfileSource implements ProfileSource {
  constructor(private readonly client: MisskeyClient, private readonly appRoles: ReadonlyMap<string, string> = new Map()) {}

  async getProfile(username: string): Promise<Profile> {
    const user = await this.client.getUserInfo(username);
    const profile = profileFromMisskeyUser(user);
    const normalizedUsername = normalizeRoleUsername(user.username);
    if (normalizedUsername !== undefined) {
      const appRole = this.appRoles.get(normalizedUsername);
      if (appRole !== undefined) profile.appRole = appRole;
    }
    try {
      const avatar = await this.client.getAvatar(user);
      if (avatar) profile.avatar = avatar.data;
    } catch {
      // Avatar failures should use the renderer's fallback without losing the profile.
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
