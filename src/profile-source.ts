export interface Profile {
  username: string;
  displayName: string;
  notesCount: number;
}

export interface ProfileSource {
  getProfile(username: string): Promise<Profile>;
}

import { MisskeyClient, type MisskeyUserInfo } from './misskey-client.js';

export class MisskeyProfileSource implements ProfileSource {
  constructor(private readonly client: MisskeyClient) {}

  async getProfile(username: string): Promise<Profile> {
    const user = await this.client.getUserInfo(username);
    return profileFromMisskeyUser(user);
  }
}

export function profileFromMisskeyUser(user: Pick<MisskeyUserInfo, 'username' | 'name' | 'notesCount'>): Profile {
  const displayName = user.name?.trim() || user.username;
  return {
    username: `@${user.username.replace(/^@/, '')}`,
    displayName,
    notesCount: user.notesCount,
  };
}
