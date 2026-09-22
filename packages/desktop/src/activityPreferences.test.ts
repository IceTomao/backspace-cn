import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-activity-preferences-'));

vi.mock('electron', () => ({ app: { getPath: () => testRoot } }));

import { loadActivityPreferences, saveActivityPreferences } from './activityPreferences';

beforeEach(() => {
  fs.rmSync(path.join(testRoot, 'activity-settings.json'), { force: true });
});

afterEach(() => {
  fs.rmSync(path.join(testRoot, 'activity-settings.json'), { force: true });
});

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe('activity preferences', () => {
  it('enables game and music activity by default', () => {
    expect(loadActivityPreferences()).toEqual({ showGames: true, showMusic: true });
  });

  it('persists an independent music choice without changing game visibility', () => {
    expect(saveActivityPreferences({ showMusic: false })).toEqual({ showGames: true, showMusic: false });
    expect(loadActivityPreferences()).toEqual({ showGames: true, showMusic: false });
  });
});
