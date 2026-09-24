import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '', getFileIcon: vi.fn(), isPackaged: false },
  nativeImage: { createFromPath: vi.fn() },
}));

import { parseGameDictionary, ProcessGameProvider } from './processGameProvider';

describe('ProcessGameProvider', () => {
  it('accepts the extended dictionary fields and ignores unsafe icon URLs', () => {
    const parsed = parseGameDictionary(JSON.stringify({ version: 2, games: [{
      id: 're2', name: 'Resident Evil 2', processes: ['re2.exe'],
      platformIds: { steam: '883710' }, iconUrl: 'https://cdn.example/re2.png',
    }, { id: 'unsafe', name: 'Unsafe', processes: ['unsafe.exe'], iconUrl: 'data:image/png,x' }] }));
    expect(parsed?.entries[0]).toMatchObject({ platformIds: { steam: '883710' }, iconUrl: 'https://cdn.example/re2.png' });
    expect(parsed?.entries[1]?.iconUrl).toBeUndefined();
  });

  it('uses OS process start time and foreground game priority', () => {
    const provider = new ProcessGameProvider() as any;
    provider.entries = [
      { id: 'nte', name: '异环', processes: ['NTE-Win64-Shipping.exe'], type: 'playing' },
      { id: 're2', name: 'Resident Evil 2', processes: ['re2.exe'], type: 'playing' },
    ];
    provider.installedGames = [];
    provider.onChange = vi.fn();
    provider.applySnapshot({ foregroundPid: 20, processes: [
      { pid: 10, name: 'NTE-Win64-Shipping.exe', startedAt: 1_000, hasWindow: true },
      { pid: 20, name: 're2.exe', startedAt: 2_000, hasWindow: true },
    ] });
    expect(provider.getActivities()[0]).toMatchObject({ name: 'Resident Evil 2', timestamps: { start: 2_000 } });
  });

  it('requires a visible window for newly discovered platform games but keeps a selected minimized game', () => {
    const provider = new ProcessGameProvider() as any;
    provider.entries = [];
    provider.installedGames = [{ id: 'steam:1', name: 'Steam Game', installDir: 'D:\\Steam\\Game', platform: 'steam' }];
    provider.onChange = vi.fn();
    const process = { pid: 1, name: 'game.exe', path: 'D:\\Steam\\Game\\game.exe', startedAt: 10, hasWindow: false };
    provider.applySnapshot({ processes: [process] });
    expect(provider.getActivities()).toEqual([]);
    process.hasWindow = true;
    provider.applySnapshot({ foregroundPid: 1, processes: [process] });
    expect(provider.getActivities()[0]?.name).toBe('Steam Game');
    process.hasWindow = false;
    provider.applySnapshot({ processes: [process] });
    expect(provider.getActivities()[0]?.name).toBe('Steam Game');
  });

  it('uses a matching platform icon for a dictionary game', () => {
    const provider = new ProcessGameProvider() as any;
    provider.entries = [{
      id: 're2', name: 'Resident Evil 2', processes: ['re2.exe'], type: 'playing', platformIds: { steam: '883710' },
    }];
    provider.installedGames = [{
      id: 'steam:883710', name: 'Resident Evil 2', installDir: 'D:\\Steam\\RE2', platform: 'steam', iconPath: 'D:\\Steam\\re2.ico',
    }];
    const candidates = provider.candidates({ processes: [{
      pid: 1, name: 're2.exe', path: 'D:\\Steam\\RE2\\re2.exe', startedAt: 10, hasWindow: true,
    }] });
    expect(candidates[0]?.iconPath).toBe('D:\\Steam\\re2.ico');
  });
});
