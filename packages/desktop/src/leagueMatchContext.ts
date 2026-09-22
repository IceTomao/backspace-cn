export interface LeagueChampionPresence {
  name?: string;
  imageUrl?: string;
}

export interface LeagueMatchContext {
  mode?: string;
  champion?: LeagueChampionPresence;
}

const MATCH_PHASES = new Set(['PreEndOfGame', 'InProgress', 'EndOfGame']);

/**
 * The champion-select endpoint disappears as soon as loading starts. Keep the
 * confirmed pick locally until this match returns to a non-match client phase.
 */
export function updateLeagueMatchContext(
  previous: LeagueMatchContext,
  phase: unknown,
  mode: string | undefined,
  champion: LeagueChampionPresence | undefined,
): LeagueMatchContext {
  if (MATCH_PHASES.has(String(phase))) {
    return {
      mode: mode ?? previous.mode,
      champion: champion ?? previous.champion,
    };
  }

  return { mode, champion };
}
