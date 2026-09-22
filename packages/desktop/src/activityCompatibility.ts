import type { DesktopActivity } from './activityTypes';

/**
 * Older bundled web clients only subscribe to the single-activity IPC event.
 * Preserve music visibility for those clients while a game is primary, without
 * changing the modern activity-array payload.
 */
export function getLegacyActivity(activities: DesktopActivity[]): DesktopActivity | null {
  const primary = activities[0];
  if (!primary || primary.type === 'listening') return primary ?? null;

  const music = activities.find((activity) => activity.type === 'listening');
  if (!music) return primary;

  const musicSummary = [music.name, music.details, music.state].filter(Boolean).join(' · ');
  if (!musicSummary) return primary;

  return {
    ...primary,
    // State has a server-side 128-character cap. Keep game metadata first so
    // an especially long song title cannot hide the game state.
    state: [primary.state, `正在听 ${musicSummary}`].filter(Boolean).join(' · ').slice(0, 128),
  };
}
