import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '' } }));

import {
  createLeagueActivity,
  normalizeLeagueMode,
  parseLcuPresence,
  parseLiveGamePresence,
  parseQueueCatalog,
  resolveLeagueMode,
} from './leagueProvider';

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

describe('League LCU presence parsing', () => {
  const catalog = parseQueueCatalog([
    { id: 9999, name: '云顶之弈' },
    { id: 10001, name: '海克斯大乱斗' },
    { id: 10002, name: '怀旧限时模式' },
  ]);

  it('uses the dynamic queue catalog before falling back to special mode', () => {
    expect(resolveLeagueMode({ id: '9999' }, {}, catalog)).toBe('云顶之弈');
    expect(resolveLeagueMode({ id: 10001 }, {}, catalog)).toBe('海克斯大乱斗');
    expect(resolveLeagueMode({ id: 10002 }, {}, catalog)).toBe('怀旧限时模式');
    expect(resolveLeagueMode({ id: 65535 }, {}, catalog)).toBe('特殊模式');
  });

  it('normalizes known internal modes without using an invented mode label', () => {
    expect(normalizeLeagueMode('PRACTICE_GAME')).toBe('训练模式');
    expect(normalizeLeagueMode('TFT')).toBe('云顶之弈');
    expect(normalizeLeagueMode('CHERRY')).toBe('斗魂竞技场');
    expect(normalizeLeagueMode('ARAM', 'Map12')).toBe('极地大乱斗');
    expect(normalizeLeagueMode('RETRO_EVENT')).toBe('RETRO_EVENT');
  });

  it('gets the local champion from the in-game session after champ select disappears', () => {
    expect(parseLcuPresence({
      phase: 'InProgress',
      currentSummoner: { puuid: 'local-puuid' },
      session: {
        gameData: {
          gameId: 123,
          queue: { id: '9999', gameMode: 'TFT' },
          playerChampionSelections: [{ puuid: 'local-puuid', championId: 222 }],
          teamOne: [],
          teamTwo: [],
        },
      },
      champSelect: null,
      queueCatalog: catalog,
    })).toEqual({ mode: '云顶之弈', championId: 222, gameId: '123' });
  });

  it('uses the local cell when current summoner identity is unavailable in champ select', () => {
    expect(parseLcuPresence({
      phase: 'ChampSelect',
      session: { gameData: { queue: { id: 2000 } } },
      champSelect: { localPlayerCellId: 7, myTeam: [{ cellId: 7, championId: 157 }] },
    })).toMatchObject({ mode: '训练模式', championId: 157 });
  });
});
