export interface Profile {
  username: string;
  displayName: string;
  notesCount: number;
  registrationDate?: string;
  appRole?: string;
  userId?: string;
  avatar?: Buffer;
}

export interface ProfileSource {
  getProfile(username: string): Promise<Profile>;
}

import { MisskeyClient, type MisskeyUserInfo } from './misskey-client.js';

export class MisskeyProfileSource implements ProfileSource {
  constructor(private readonly client: MisskeyClient) {}

  async getProfile(username: string): Promise<Profile> {
    const user = await this.client.getUserInfo(username);
    const profile = profileFromMisskeyUser(user);
    try {
      const avatar = await this.client.getAvatar(user);
      if (avatar) profile.avatar = avatar.data;
    } catch {
      // Avatar failures should use the renderer's fallback without losing the profile.
    }
    return profile;
  }
}

export function profileFromMisskeyUser(user: Pick<MisskeyUserInfo, 'username' | 'name' | 'notesCount'> & Partial<Pick<MisskeyUserInfo, 'id' | 'createdAt'>>): Profile {
  const displayName = user.name?.trim() || user.username;
  const profile: Profile = {
    username: `@${user.username.replace(/^@/, '')}`,
    displayName,
    notesCount: user.notesCount,
  };
  if (typeof user.id === 'string' && user.id.trim()) profile.userId = user.id;
  if (typeof user.createdAt === 'string') profile.registrationDate = user.createdAt;
  return profile;
}
