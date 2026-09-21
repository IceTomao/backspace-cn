import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ThemeManager,
  canReadThemeStyles,
  readThemeMode,
  registerThemeStyles,
  type ThemeMode,
} from './theme';

class FakeNativeTheme {
  themeSource: ThemeMode = 'system';
  shouldUseDarkColors = false;
  private listeners = new Set<() => void>();

  on(_event: 'updated', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeListener(_event: 'updated', listener: () => void): void {
    this.listeners.delete(listener);
  }

  emitUpdated(): void {
    for (const listener of this.listeners) listener();
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

const tempDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function tempFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-theme-'));
  tempDirectories.push(directory);
  return path.join(directory, 'theme.json');
}

describe('ThemeManager', () => {
  it('defaults missing, malformed, and invalid preferences to system', () => {
    const file = tempFile();
    expect(readThemeMode(file)).toBe('system');
    fs.writeFileSync(file, '{not json');
    expect(readThemeMode(file)).toBe('system');
    fs.writeFileSync(file, JSON.stringify({ mode: 'blue' }));
    expect(readThemeMode(file)).toBe('system');
    fs.writeFileSync(file, JSON.stringify({ mode: null }));
    expect(readThemeMode(file)).toBe('system');
    for (const invalid of [null, [], 1, 'light', { theme: 'dark' }]) {
      fs.writeFileSync(file, JSON.stringify(invalid));
      expect(readThemeMode(file)).toBe('system');
    }
  });

  it('restores a saved manual mode and gives it priority over system changes', () => {
    const file = tempFile();
    fs.writeFileSync(file, JSON.stringify({ mode: 'dark' }));
    const native = new FakeNativeTheme();
    const manager = new ThemeManager(native, file);
    expect(manager.getMode()).toBe('dark');
    expect(native.themeSource).toBe('dark');
    native.shouldUseDarkColors = false;
    expect(manager.isDark()).toBe(true);
    manager.dispose();
  });

  it('notifies subscribers for system changes and removes the native listener on dispose', () => {
    const native = new FakeNativeTheme();
    const manager = new ThemeManager(native, tempFile());
    const listener = vi.fn();
    manager.subscribe(listener);
    native.shouldUseDarkColors = true;
    native.emitUpdated();
    expect(manager.isDark()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    manager.dispose();
    native.emitUpdated();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(native.listenerCount()).toBe(0);
  });

  it('keeps the previous selection and native source when saving fails', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const native = new FakeNativeTheme();
    const manager = new ThemeManager(native, path.join(tempFile(), 'missing', 'theme.json'));
    expect(manager.setMode('dark')).toBe(false);
    expect(manager.getMode()).toBe('system');
    expect(native.themeSource).toBe('system');
    manager.dispose();
  });

  it('persists across manager restarts and returns to the system preference', () => {
    const file = tempFile();
    const native = new FakeNativeTheme();
    native.shouldUseDarkColors = true;
    const manager = new ThemeManager(native, file);
    const changed = vi.fn();
    const unsubscribe = manager.subscribe(changed);
    expect(manager.setMode('light')).toBe(true);
    native.emitUpdated();
    expect(manager.isDark()).toBe(false);
    expect(native.themeSource).toBe('light');
    unsubscribe();
    changed.mockClear();
    native.emitUpdated();
    expect(changed).not.toHaveBeenCalled();
    manager.dispose();
    const restarted = new ThemeManager(native, file);
    expect(restarted.getMode()).toBe('light');
    expect(restarted.setMode('system')).toBe(true);
    expect(restarted.isDark()).toBe(true);
    native.shouldUseDarkColors = false;
    native.emitUpdated();
    expect(restarted.isDark()).toBe(false);
    expect(readThemeMode(file)).toBe('system');
    restarted.dispose();
  });

  it('does not change the existing file or selection when atomic replacement fails', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = tempFile();
    fs.writeFileSync(file, JSON.stringify({ mode: 'dark' }));
    const native = new FakeNativeTheme();
    const manager = new ThemeManager(native, file);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('file locked'); });
    expect(manager.setMode('light')).toBe(false);
    expect(readThemeMode(file)).toBe('dark');
    expect(manager.getMode()).toBe('dark');
    expect(native.themeSource).toBe('dark');
    manager.dispose();
  });

  it('rejects invalid selections and does not rewrite an unchanged mode', () => {
    const file = tempFile();
    const manager = new ThemeManager(new FakeNativeTheme(), file);
    expect(manager.setMode('bad' as ThemeMode)).toBe(false);
    expect(manager.setMode('system')).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    manager.dispose();
  });
});

describe('theme stylesheet IPC guard', () => {
  it('accepts only the current main frame and rejects arguments and subframes', () => {
    const mainFrame = { url: 'https://chat.kevz.me:2096/' };
    const webContents = { mainFrame };
    const win = {
      isDestroyed: () => false,
      webContents,
    };
    const event = { sender: webContents, senderFrame: mainFrame };
    const localPages = new Set<string>();
    expect(canReadThemeStyles(event as never, win as never, localPages)).toBe(true);
    expect(canReadThemeStyles({ ...event, senderFrame: { url: mainFrame.url } } as never, win as never, localPages)).toBe(false);
    expect(canReadThemeStyles({ ...event, sender: {} } as never, win as never, localPages)).toBe(false);
    expect(canReadThemeStyles(event as never, null, localPages)).toBe(false);
    expect(canReadThemeStyles(event as never, { ...win, isDestroyed: () => true } as never, localPages)).toBe(false);
    expect(canReadThemeStyles({ ...event, senderFrame: null } as never, win as never, localPages)).toBe(false);
    for (const url of ['about:blank', 'data:text/html,hello', 'not-a-url', 'file:///secrets.txt']) {
      mainFrame.url = url;
      expect(canReadThemeStyles(event as never, win as never, localPages)).toBe(false);
    }
  });

  it('allows only exact bundled local pages and exposes fixed CSS without parameters', () => {
    const mainFrame = { url: 'file:///app/resources/instance-picker.html?lang=zh' };
    const webContents = { mainFrame };
    const win = { isDestroyed: () => false, webContents };
    const localPages = new Set(['file:///app/resources/instance-picker.html']);
    expect(canReadThemeStyles({ sender: webContents, senderFrame: mainFrame } as never, win as never, localPages)).toBe(true);
    mainFrame.url = 'file:///app/resources/other.html';
    expect(canReadThemeStyles({ sender: webContents, senderFrame: mainFrame } as never, win as never, localPages)).toBe(false);
    mainFrame.url = 'file:///app/resources/instance-picker.html?lang=zh#section';

    let listener: ((event: { sender: unknown; senderFrame: unknown }, ...args: unknown[]) => void) | undefined;
    const ipc = {
      on: vi.fn((_channel: string, callback: typeof listener) => { listener = callback; }),
      removeListener: vi.fn(),
    };
    const dispose = registerThemeStyles(ipc as never, () => win as never, 'fixed-css', localPages);
    const allowed = { sender: webContents, senderFrame: mainFrame, returnValue: '' };
    listener!(allowed);
    expect(allowed.returnValue).toBe('fixed-css');
    const withArgs = { ...allowed, returnValue: '' };
    listener!(withArgs, 'ignored');
    expect(withArgs.returnValue).toBe('');
    dispose();
    expect(ipc.removeListener).toHaveBeenCalledTimes(1);
  });
});
