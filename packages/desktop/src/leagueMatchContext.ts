export interface LeagueChampionPresence {
  name?: string;
  imageUrl?: string;
}

export interface LeagueMatchContext {
  gameId?: string;
  mode?: string;
  champion?: LeagueChampionPresence;
}

const MATCH_PHASES = new Set([
  'GameStart',
  'InProgress',
  'WaitingForStats',
  'PreEndOfGame',
  'EndOfGame',
  'Reconnect',
]);

/**
 * The champion-select endpoint disappears as soon as loading starts. Keep the
 * confirmed pick locally until this match returns to a non-match client phase.
 */
export function updateLeagueMatchContext(
  previous: LeagueMatchContext,
  phase: unknown,
  mode: string | undefined,
  champion: LeagueChampionPresence | undefined,
  gameId?: string,
): LeagueMatchContext {
  if (MATCH_PHASES.has(String(phase))) {
    if (gameId && previous.gameId && gameId !== previous.gameId) {
      return { gameId, mode, champion };
    }
    return {
      gameId: gameId ?? previous.gameId,
      mode: mode ?? previous.mode,
      champion: champion ?? previous.champion,
    };
  }

  return { gameId, mode, champion };
}
