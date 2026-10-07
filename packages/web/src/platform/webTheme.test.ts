import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWebThemeMode, initializeWebTheme, resolveTheme, setWebThemeMode, WEB_THEME_KEY } from './webTheme';

describe('web theme', () => {
  afterEach(() => {
    localStorage.removeItem(WEB_THEME_KEY);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('defaults to the system color scheme', () => {
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
  });

  it('keeps explicit light and dark choices independent of the system', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('persists an explicit choice locally and applies it to the root', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true } as MediaQueryList));
    setWebThemeMode('light');
    expect(getWebThemeMode()).toBe('light');
    expect(document.documentElement.dataset.colorScheme).toBe('light');
  });

  it('follows later system changes only while the saved mode is system', () => {
    let dark = true;
    let listener: (() => void) | undefined;
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
      get matches() { return dark; },
      addEventListener: (_type: string, callback: () => void) => { listener = callback; },
      removeEventListener: vi.fn(),
    }) as unknown as MediaQueryList));
    localStorage.setItem(WEB_THEME_KEY, 'system');
    const stop = initializeWebTheme();
    expect(document.documentElement.dataset.colorScheme).toBe('dark');
    dark = false;
    listener?.();
    expect(document.documentElement.dataset.colorScheme).toBe('light');
    setWebThemeMode('dark');
    dark = false;
    listener?.();
    expect(document.documentElement.dataset.colorScheme).toBe('dark');
    stop();
  });
});
