import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { DESKTOP_BUILD, resolveInstanceUrl } from './buildConfig';
import {
  RecoveryStateStore, buildTrayMenuTemplate, buildAppMenuTemplate,
  handleRecoveryAction, setAutoUpdater, setMainWindow,
} from './recovery';
import { shell } from 'electron';

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '', getLocale: () => 'en-US' },
  shell: { openExternal: vi.fn() },
}));
vi.mock('./instanceUrl', async () => {
  const { DESKTOP_BUILD } = await import('./buildConfig');
  return {
    getResolvedInstanceUrl: () => DESKTOP_BUILD.defaultInstanceUrl,
    getPickerPath: () => 'instance-picker.html',
  };
});

describe('Chinese distribution', () => {
  it('uses environment, saved instance, then public default in that order', () => {
    expect(resolveInstanceUrl('https://managed.example', 'https://saved.example')).toBe('https://managed.example');
    expect(resolveInstanceUrl(undefined, 'https://saved.example')).toBe('https://saved.example');
    expect(resolveInstanceUrl(undefined, null)).toBe('https://chat.kevz.me:2096');
    expect(DESKTOP_BUILD.updatesEnabled).toBe(false);
  });

  it('hides all update actions, even if an obsolete state says downloaded', () => {
    const state = { ...new RecoveryStateStore().get(), updateState: 'downloaded' as const };
    const tray = buildTrayMenuTemplate(state);
    const menu = buildAppMenuTemplate('Backspace', state);
    expect(JSON.stringify([tray, menu])).not.toMatch(/check-for-updates|restart-to-install|download-update/);
  });

  it('blocks every recovery update action before invoking updater or shell', () => {
    const updater = { checkForUpdates: vi.fn(), quitAndInstall: vi.fn() };
    setAutoUpdater(updater as never);
    for (const action of ['check-update', 'install-update', 'open-releases'] as const) {
      handleRecoveryAction(action);
    }
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
    setAutoUpdater(null);
  });

  it('retries the default instance but leaves an explicit switch on the picker', () => {
    const win = { loadURL: vi.fn(), loadFile: vi.fn(), show: vi.fn(), focus: vi.fn() };
    setMainWindow(win as never);
    handleRecoveryAction('reload');
    expect(win.loadURL).toHaveBeenCalledWith(DESKTOP_BUILD.defaultInstanceUrl);
    win.loadURL.mockClear();
    handleRecoveryAction('change-instance');
    expect(win.loadURL).not.toHaveBeenCalled();
    expect(win.loadFile).toHaveBeenCalledWith('instance-picker.html', { query: { lang: 'zh' } });
    setMainWindow(null);
  });
});

const preload = ts.transpileModule(readFileSync(path.join(__dirname, 'preload.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function runPreload(protocol: string, stored: string | null, blocked = false) {
  const storage = {
    getItem: vi.fn(() => { if (blocked) throw new Error('blocked'); return stored; }),
    setItem: vi.fn(),
  };
  const exposeInMainWorld = vi.fn();
  vm.runInNewContext(preload, {
    exports: {},
    require: (name: string) => {
      if (name !== 'electron') throw new Error(`Sandbox forbids ${name}`);
      return { contextBridge: { exposeInMainWorld }, ipcRenderer: {} };
    },
    process: { platform: 'win32', argv: ['electron', '--backspace-default-language=zh'] },
    window: { location: { protocol }, localStorage: storage },
  });
  return { storage, exposeInMainWorld };
}

describe('sandboxed language bootstrap', () => {
  it.each(['http:', 'https:'])('initializes missing preferences on %s', (protocol) => {
    expect(runPreload(protocol, null).storage.setItem).toHaveBeenCalledWith('backspace-language', 'zh');
  });
  it.each(['en', 'ru', 'de', 'zh'])('preserves an existing %s preference', (language) => {
    expect(runPreload('https:', language).storage.setItem).not.toHaveBeenCalled();
  });
  it('does not touch file-page storage', () => {
    expect(runPreload('file:', null).storage.getItem).not.toHaveBeenCalled();
  });
  it('still exposes the bridge when storage is blocked', () => {
    expect(runPreload('https:', null, true).exposeInMainWorld).toHaveBeenCalledWith('backspace', expect.any(Object));
  });
});

describe('standalone Chinese catalogs', () => {
  for (const filename of ['instance-picker.html', 'recovery.html']) {
    it(`${filename} has complete keys and matching placeholders`, () => {
      const html = readFileSync(path.join(__dirname, '../resources', filename), 'utf8');
      const script = html.split('const STRINGS = ')[1]?.split('    const LANG')[0];
      expect(script).toBeDefined();
      const catalogs = vm.runInNewContext(`(${script!.trim().replace(/;$/, '')})`);
      expect(Object.keys(catalogs.zh).sort()).toEqual(Object.keys(catalogs.en).sort());
      const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      for (const key of Object.keys(catalogs.en)) {
        expect(catalogs.zh[key].trim().length).toBeGreaterThan(0);
        expect(placeholders(catalogs.zh[key])).toEqual(placeholders(catalogs.en[key]));
      }
    });
  }
});
