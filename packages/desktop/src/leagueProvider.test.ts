import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '' } }));

import { createLeagueActivity } from './leagueProvider';

describe('League activity fallback', () => {
  it('creates a base playing activity when LCU details are unavailable', () => {
    expect(createLeagueActivity(1760000000123)).toEqual({
      source: 'game',
      type: 'playing',
      name: 'League of Legends',
      timestamps: { start: 1760000000123 },
    });
  });
});
