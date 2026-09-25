import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const mockPaths = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => mockPaths.userData, getFileIcon: vi.fn(), isPackaged: false },
  nativeImage: { createFromPath: vi.fn() },
}));

import { parseGameDictionary, ProcessGameProvider } from './processGameProvider';

describe('ProcessGameProvider', () => {
  it('recognizes both shipping and live NTE process names from the bundled catalog', () => {
    const catalog = parseGameDictionary(fs.readFileSync(path.join(__dirname, '..', 'resources', 'games.json'), 'utf8'));
    const entry = catalog?.entries.find((game) => game.id === 'neverness-to-everness');
    expect(entry?.processes).toEqual(expect.arrayContaining(['NTE-Win64-Shipping.exe', 'NTEGame.exe']));

    for (const name of ['NTE-Win64-Shipping.exe', 'NTEGame.exe']) {
      const provider = new ProcessGameProvider() as any;
      provider.entries = [entry];
      provider.installedGames = [];
      provider.applySnapshot({ processes: [{ pid: 1, name, hasWindow: true }] });
      expect(provider.getActivities()[0]).toMatchObject({ type: 'playing', name: '异环' });
    }
  });

  it('does not replace the bundled NTE alias with an older remote catalog', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-game-catalog-'));
    mockPaths.userData = userData;
    const oldCatalog = JSON.stringify({ version: 2, games: [{
      id: 'neverness-to-everness', name: '异环', processes: ['NTE-Win64-Shipping.exe'],
    }] });
    const request = vi.spyOn(https, 'get').mockImplementation(((_url: unknown, _options: unknown,
      callback: (response: EventEmitter) => void) => {
      const result = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
      queueMicrotask(() => {
        callback(result);
        result.emit('data', Buffer.from(oldCatalog));
        result.emit('end');
      });
      return new EventEmitter();
    }) as unknown as typeof https.get);
    try {
      const provider = new ProcessGameProvider() as any;
      provider.entries = [{ id: 'neverness-to-everness', name: '异环', processes: ['NTEGame.exe'] }];
      provider.catalogVersion = 3;
      await provider.syncRemote();
      expect(provider.entries[0].processes).toContain('NTEGame.exe');
      expect(fs.existsSync(path.join(userData, 'games-cache.json'))).toBe(false);
    } finally {
      request.mockRestore();
      mockPaths.userData = '';
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

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
