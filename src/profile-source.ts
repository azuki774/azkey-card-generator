import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Profile {
  username: string;
  displayName: string;
  notesCount: number;
  appRole?: string;
  userId?: string;
  avatar?: Buffer;
}

/**
 * Temporary profile source used until the azkey API integration is added.
 * Keeping this behind an interface makes the renderer independent from the
 * eventual API client.
 */
export interface ProfileSource {
  getProfile(username: string): Promise<Profile>;
}

export class PlaceholderProfileSource implements ProfileSource {
  async getProfile(username: string): Promise<Profile> {
    const sourceDirectory = dirname(fileURLToPath(import.meta.url));
    const avatar = await readFile(resolve(sourceDirectory, '../assets/card-templates/default/front/icons/placeholder.svg'));
    return {
      username,
      displayName: 'Sample User',
      notesCount: 0,
      userId: 'placeholder-profile',
      avatar,
    };
  }
}
