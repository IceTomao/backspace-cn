import fs from 'node:fs';
import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron';

export type ThemeMode = 'system' | 'light' | 'dark';
export const THEME_STYLES_CHANNEL = 'desktop-theme-styles';

interface NativeThemeSource {
  themeSource: ThemeMode;
  readonly shouldUseDarkColors: boolean;
  on(event: 'updated', listener: () => void): unknown;
  removeListener(event: 'updated', listener: () => void): unknown;
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function readThemeMode(file: string): ThemeMode {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && 'mode' in parsed && isThemeMode(parsed.mode)) {
      return parsed.mode;
    }
  } catch {
    // Missing or damaged local preferences use the OS application theme.
  }
  return 'system';
}

export class ThemeManager {
  private mode: ThemeMode;
  private listeners = new Set<() => void>();
  private readonly onUpdated = () => {
    for (const listener of this.listeners) listener();
  };

  constructor(private readonly native: NativeThemeSource, private readonly file: string) {
    this.mode = readThemeMode(file);
    native.themeSource = this.mode;
    native.on('updated', this.onUpdated);
  }

  getMode(): ThemeMode {
    return this.mode;
  }

  isDark(): boolean {
    return this.mode === 'system' ? this.native.shouldUseDarkColors : this.mode === 'dark';
  }

  setMode(mode: ThemeMode): boolean {
    if (!isThemeMode(mode)) return false;
    if (mode === this.mode) return true;
    // Save before applying, so a failed write cannot silently lose a selection.
    try {
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ mode }), { mode: 0o600 });
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch (error) {
      console.warn('[theme] Could not save preference:', error);
      return false;
    }
    this.mode = mode;
    this.native.themeSource = mode;
    this.onUpdated();
    return true;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    this.native.removeListener('updated', this.onUpdated);
    this.listeners.clear();
  }
}

export function windowThemeColors(dark: boolean): { color: string; symbolColor: string } {
  return dark
    ? { color: '#0b0b10', symbolColor: '#d8d8de' }
    : { color: '#f3f4f6', symbolColor: '#25272c' };
}

export function canReadThemeStyles(
  event: Pick<IpcMainEvent, 'sender' | 'senderFrame'>,
  win: BrowserWindow | null,
  localPages: ReadonlySet<string>,
): boolean {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return false;
  if (!event.senderFrame || event.senderFrame !== win.webContents.mainFrame) return false;
  try {
    const url = new URL(event.senderFrame.url);
    if (url.protocol === 'http:' || url.protocol === 'https:') return true;
    url.search = '';
    url.hash = '';
    return url.protocol === 'file:' && localPages.has(url.href);
  } catch {
    return false;
  }
}

export function registerThemeStyles(
  ipc: Pick<IpcMain, 'on' | 'removeListener'>,
  getWindow: () => BrowserWindow | null,
  styles: string,
  localPages: ReadonlySet<string>,
): () => void {
  // One fixed, memory-cached response before first paint. No renderer paths,
  // CSS, scripts or theme-setting commands are accepted by this channel.
  const listener = (event: IpcMainEvent, ...args: unknown[]) => {
    event.returnValue = args.length === 0 && canReadThemeStyles(event, getWindow(), localPages) ? styles : '';
  };
  ipc.on(THEME_STYLES_CHANNEL, listener);
  return () => { ipc.removeListener(THEME_STYLES_CHANNEL, listener); };
}

export function registerThemeControls(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  getWindow: () => BrowserWindow | null,
  manager: ThemeManager,
): () => void {
  const allowed = (event: Pick<IpcMainEvent, 'sender' | 'senderFrame'>) =>
    canReadThemeStyles(event, getWindow(), new Set());
  ipc.handle('desktop-theme-get', (event, ...args: unknown[]) => {
    if (args.length || !allowed(event)) throw new Error('Theme request denied');
    return manager.getMode();
  });
  ipc.handle('desktop-theme-set', (event, ...args: unknown[]) => {
    if (args.length !== 1 || !isThemeMode(args[0]) || !allowed(event)) {
      throw new Error('Theme request denied');
    }
    const ok = manager.setMode(args[0]);
    return { ok, mode: manager.getMode() };
  });
  const unsubscribe = manager.subscribe(() => {
    const win = getWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('desktop-theme-changed', manager.getMode());
    }
  });
  return () => {
    unsubscribe();
    ipc.removeHandler('desktop-theme-get');
    ipc.removeHandler('desktop-theme-set');
  };
}
