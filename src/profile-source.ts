export interface Profile {
  username: string;
  displayName: string;
  notesCount: number;
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
    return {
      username,
      displayName: 'Sample User',
      notesCount: 0,
    };
  }
}
