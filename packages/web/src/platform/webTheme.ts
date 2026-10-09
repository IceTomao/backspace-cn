import { appStorage } from './appStorage';
import { isAndroid } from './android';
import { isElectron } from './platform';

export type ThemeMode = 'system' | 'light' | 'dark';
export const WEB_THEME_KEY = 'backspace-theme';

function validMode(value: string | null): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function getWebThemeMode(): ThemeMode {
  const stored = appStorage.getItem(WEB_THEME_KEY);
  return validMode(stored) ? stored : 'system';
}

export function resolveTheme(mode: ThemeMode, systemDark: boolean): 'light' | 'dark' {
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
}

export function setWebThemeMode(mode: ThemeMode): void {
  appStorage.setItem(WEB_THEME_KEY, mode);
  applyTheme(mode);
}

function updateThemeColor(theme: 'light' | 'dark'): void {
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
    'content', theme === 'light' ? '#f4f4f6' : '#0b0b10',
  );
  document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]')?.setAttribute(
    'content', theme === 'light' ? 'default' : 'black',
  );
}

function applyTheme(mode: ThemeMode): void {
  const theme = resolveTheme(mode, window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.colorScheme = theme;
  updateThemeColor(theme);
}

/** Apply the browser/PWA preference before React starts. Native clients own theirs. */
export function initializeWebTheme(): () => void {
  if (isAndroid() || isElectron()) return () => undefined;
  const mode = getWebThemeMode();
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemChange = () => {
    const current = getWebThemeMode();
    if (current === 'system') applyTheme(current);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === WEB_THEME_KEY || event.key === null) applyTheme(getWebThemeMode());
  };
  applyTheme(mode);
  media.addEventListener?.('change', onSystemChange);
  window.addEventListener('storage', onStorage);
  return () => {
    media.removeEventListener?.('change', onSystemChange);
    window.removeEventListener('storage', onStorage);
  };
}
