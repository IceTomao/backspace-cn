import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '' } }));

import {
  createLeagueActivity,
  leagueChampionIconUrl,
  leagueChampionIconUrlFromRawName,
  normalizeLeagueMode,
  parseLcuPresence,
  parseLiveGamePresence,
  parseQueueCatalog,
  resolveLeagueMode,
} from './leagueProvider';
import { updateLeagueMatchStart } from './leagueMatchContext';

describe('League activity fallback', () => {
  it('creates a base playing activity without a client-lifetime timer or placeholder avatar', () => {
    expect(createLeagueActivity()).toEqual({
      source: 'game',
      type: 'playing',
      name: 'League of Legends',
    });
  });

  it('starts the timer only at InProgress and preserves it across reconnects', () => {
    const started = updateLeagueMatchStart(undefined, 'InProgress', 1_760_000_000_000);
    expect(started).toBe(1_760_000_000_000);
    expect(updateLeagueMatchStart(started, 'Reconnect', 1_760_000_030_000)).toBe(started);
  });

  it('does not time loading or post-match phases and starts a later match independently', () => {
    expect(updateLeagueMatchStart(undefined, 'GameStart', 1_760_000_000_000)).toBeUndefined();
    const started = updateLeagueMatchStart(undefined, 'InProgress', 1_760_000_000_000);
    expect(updateLeagueMatchStart(started, 'EndOfGame', 1_760_003_000_000)).toBeUndefined();
    expect(updateLeagueMatchStart(undefined, 'InProgress', 1_760_100_000_000)).toBe(1_760_100_000_000);
  });

  it('uses a stable public champion icon URL', () => {
    expect(leagueChampionIconUrl(39)).toBe(
      'https://cdn.communitydragon.org/latest/champion/39/square',
    );
    expect(leagueChampionIconUrlFromRawName('game_character_displayname_Irelia')).toBe(
      'https://cdn.communitydragon.org/latest/champion/Irelia/square',
    );
    expect(leagueChampionIconUrlFromRawName('not/a/champion')).toBeUndefined();
  });
});

describe('League in-game API fallback', () => {
  it('maps the local player champion and practice mode', () => {
    expect(parseLiveGamePresence({
      activePlayer: { summonerName: 'player' },
      gameData: { gameMode: 'CLASSIC', gameType: 'PRACTICE_GAME', mapName: 'Map11' },
      allPlayers: [{ summonerName: 'player', championName: '亚索' }],
    })).toEqual({ championName: '亚索', mode: '训练模式' });
  });

  it('maps ARAM without requiring LCU queue data', () => {
    expect(parseLiveGamePresence({
      gameData: { gameMode: 'ARAM', mapName: 'Map12' },
      allPlayers: [],
    })).toEqual({ mode: '极地大乱斗' });
  });

  it('accepts a champion supplied directly by the live API active player', () => {
    expect(parseLiveGamePresence({
      activePlayer: { championName: '亚索' },
      gameData: { gameMode: 'CLASSIC', mapName: 'Map11' },
      allPlayers: [],
    })).toEqual({ championName: '亚索', mode: '经典模式' });
  });

  it('matches the local player using Riot ID when summonerName is absent', () => {
    expect(parseLiveGamePresence({
      activePlayer: { summonerName: '训练玩家' },
      gameData: { gameMode: 'CLASSIC', gameType: 'PRACTICE_GAME', mapName: 'Map11' },
      allPlayers: [{
        riotIdGameName: '训练玩家',
        championName: '刀锋舞者',
        rawChampionName: 'game_character_displayname_Irelia',
      }],
    })).toEqual({
      championName: '刀锋舞者',
      imageUrl: 'https://cdn.communitydragon.org/latest/champion/Irelia/square',
      mode: '训练模式',
    });
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

  it('matches training-game data by summoner name when PUUID is absent', () => {
    expect(parseLcuPresence({
      phase: 'InProgress',
      currentSummoner: { summonerName: '训练玩家' },
      session: {
        gameData: {
          queue: { id: 2000 },
          playerChampionSelections: [{ summonerName: '训练玩家', championId: 157 }],
        },
      },
    })).toMatchObject({ mode: '训练模式', championId: 157 });
  });
});
