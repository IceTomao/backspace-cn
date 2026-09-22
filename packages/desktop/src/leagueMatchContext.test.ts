import { describe, expect, it } from 'vitest';
import { updateLeagueMatchContext } from './leagueMatchContext';

describe('updateLeagueMatchContext', () => {
  const lockedPick = {
    mode: '排位单人/双人',
    champion: {
      name: '亚索',
      imageUrl: 'https://ddragon.leagueoflegends.com/cdn/15.1.1/img/champion/Yasuo.png',
    },
  };

  it('keeps the locked champion and mode through loading, play, and results', () => {
    const loading = updateLeagueMatchContext(lockedPick, 'PreEndOfGame', undefined, undefined);
    const inGame = updateLeagueMatchContext(loading, 'InProgress', undefined, undefined);
    const results = updateLeagueMatchContext(inGame, 'EndOfGame', undefined, undefined);

    expect(results).toEqual(lockedPick);
  });

  it('clears the previous match context after returning to the lobby', () => {
    expect(updateLeagueMatchContext(lockedPick, 'Lobby', undefined, undefined)).toEqual({});
  });
});
