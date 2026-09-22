import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '' } }));

import { createLeagueActivity, parseLiveGamePresence } from './leagueProvider';

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

describe('League in-game API fallback', () => {
  it('maps the local player champion and practice mode', () => {
    expect(parseLiveGamePresence({
      activePlayer: { summonerName: 'player' },
      gameData: { gameMode: 'CLASSIC', gameType: 'PRACTICE_GAME', mapName: 'Map11' },
      playerList: [{ summonerName: 'player', championName: '亚索' }],
    })).toEqual({ championName: '亚索', mode: '训练模式' });
  });

  it('maps ARAM without requiring LCU queue data', () => {
    expect(parseLiveGamePresence({
      gameData: { gameMode: 'ARAM', mapName: 'Map12' },
      playerList: [],
    })).toEqual({ mode: '极地大乱斗' });
  });
});
