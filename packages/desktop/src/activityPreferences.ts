import fs from 'fs';
import path from 'path';
import { app, type IpcMain } from 'electron';

export interface ActivityPreferences {
  showGames: boolean;
  showMusic: boolean;
  showActivityImages: boolean;
}

const DEFAULTS: ActivityPreferences = { showGames: true, showMusic: true, showActivityImages: true };

function preferencesPath(): string {
  return path.join(app.getPath('userData'), 'activity-settings.json');
}

export function loadActivityPreferences(): ActivityPreferences {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(preferencesPath(), 'utf8'));
    if (!value || typeof value !== 'object') return { ...DEFAULTS };
    const input = value as Partial<ActivityPreferences>;
    return {
      showGames: typeof input.showGames === 'boolean' ? input.showGames : DEFAULTS.showGames,
      showMusic: typeof input.showMusic === 'boolean' ? input.showMusic : DEFAULTS.showMusic,
      showActivityImages: typeof input.showActivityImages === 'boolean' ? input.showActivityImages : DEFAULTS.showActivityImages,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveActivityPreferences(input: Partial<ActivityPreferences>): ActivityPreferences {
  const next = { ...loadActivityPreferences(), ...input };
  const file = preferencesPath();
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(temporary, file);
  return next;
}

export function registerActivityPreferenceHandlers(ipc: IpcMain, onChange: (preferences: ActivityPreferences) => void): void {
  ipc.handle('get-activity-preferences', () => loadActivityPreferences());
  ipc.handle('set-activity-preferences', (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('Invalid activity preferences');
    const raw = input as Record<string, unknown>;
    const patch: Partial<ActivityPreferences> = {};
    if (typeof raw.showGames === 'boolean') patch.showGames = raw.showGames;
    if (typeof raw.showMusic === 'boolean') patch.showMusic = raw.showMusic;
    if (typeof raw.showActivityImages === 'boolean') patch.showActivityImages = raw.showActivityImages;
    const preferences = saveActivityPreferences(patch);
    onChange(preferences);
    return preferences;
  });
}
