import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import {
  RecoveryStateStore,
  extractErrorCode,
  buildTrayMenuTemplate,
  buildAppMenuTemplate,
  type RecoveryState,
  armBootTimer,
  clearBootTimer,
  isBootArmed,
  handleRendererReady,
  resetBootTimerStateForTest,
  recoveryStore,
  isTransientLoadFailure,
  isRetryableNavigation,
  nextAutoRetryDelayMs,
  setReachabilityProbe,
  isAutoRetryActive,
  stopAutoRetry,
  startAutoRetry,
  attachRecoveryHandlers,
  setMainWindow,
} from './recovery';

// Mock electron with isPackaged=true so the real arm path executes in all tests below.
// getLocale/getPath keep the recovery.html navigation helpers usable in unit tests.
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getLocale: () => 'en',
    getPath: () => 'C:\\tmp\\backspace-recovery-test',
  },
  shell: { openExternal: () => Promise.resolve() },
  net: { fetch: () => Promise.reject(new Error('network disabled in tests')) },
}));

describe('RecoveryStateStore', () => {
  it('returns the initial state', () => {
    const store = new RecoveryStateStore();
    const s = store.get();
    expect(s.mode).toBe('normal');
    expect(s.reason).toBeNull();
    expect(s.updateState).toBe('idle');
    expect(s.updateVersion).toBeNull();
    expect(s.lastUpdateError).toBeNull();
    expect(s.lastCheckResult).toBeNull();
  });

  it('shallow-merges partial updates', () => {
    const store = new RecoveryStateStore();
    store.update({ updateState: 'checking' });
    expect(store.get().updateState).toBe('checking');
    expect(store.get().mode).toBe('normal');
    store.update({ updateVersion: '1.2.3' });
    expect(store.get().updateState).toBe('checking');
    expect(store.get().updateVersion).toBe('1.2.3');
  });

  it('fires listeners on every update', () => {
    const store = new RecoveryStateStore();
    const cb = vi.fn();
    store.subscribe(cb);
    store.update({ updateState: 'checking' });
    store.update({ updateState: 'idle' });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('subscribers receive the latest snapshot', () => {
    const store = new RecoveryStateStore();
    let received: RecoveryState | null = null;
    store.subscribe((s) => { received = s; });
    store.update({ updateState: 'downloaded', updateVersion: '2.0.0' });
    expect(received).not.toBeNull();
    expect(received!.updateState).toBe('downloaded');
    expect(received!.updateVersion).toBe('2.0.0');
  });

  it('unsubscribe stops callbacks', () => {
    const store = new RecoveryStateStore();
    const cb = vi.fn();
    const unsub = store.subscribe(cb);
    store.update({ updateState: 'checking' });
    unsub();
    store.update({ updateState: 'idle' });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('multiple subscribers all receive updates', () => {
    const store = new RecoveryStateStore();
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    store.update({ updateState: 'checking' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('isInRecoveryMode is false initially, true after markRecoveryEntered, false after markRecoveryExited', () => {
    const store = new RecoveryStateStore();
    expect(store.isInRecoveryMode()).toBe(false);
    store.markRecoveryEntered();
    expect(store.isInRecoveryMode()).toBe(true);
    store.markRecoveryExited();
    expect(store.isInRecoveryMode()).toBe(false);
  });

  it('a throwing listener does not stop other listeners', () => {
    const store = new RecoveryStateStore();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = vi.fn(() => { throw new Error('boom'); });
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    expect(() => store.update({ updateState: 'checking' })).not.toThrow();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('a listener can unsubscribe itself during notification without breaking the pass', () => {
    const store = new RecoveryStateStore();
    const b = vi.fn();
    let unsubA: (() => void) | null = null;
    unsubA = store.subscribe(() => { unsubA?.(); });
    store.subscribe(b);
    expect(() => store.update({ updateState: 'checking' })).not.toThrow();
    // Second update: the self-unsubscribed listener should be gone, b still fires
    store.update({ updateState: 'idle' });
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('returned state is frozen — accidental external mutation throws in strict mode', () => {
    const store = new RecoveryStateStore();
    store.update({ updateState: 'checking' });
    const s = store.get();
    expect(Object.isFrozen(s)).toBe(true);
  });
});

describe('extractErrorCode', () => {
  it('extracts string code from Error-like object', () => {
    const err = new Error('boom') as Error & { code: string };
    err.code = 'ENOSPC';
    expect(extractErrorCode(err)).toBe('ENOSPC');
  });

  it('returns null for Error without code', () => {
    expect(extractErrorCode(new Error('boom'))).toBeNull();
  });

  it('returns null when code is non-string', () => {
    const err = { code: 42 };
    expect(extractErrorCode(err)).toBeNull();
  });

  it('returns null for null/undefined/primitives', () => {
    expect(extractErrorCode(null)).toBeNull();
    expect(extractErrorCode(undefined)).toBeNull();
    expect(extractErrorCode('string')).toBeNull();
    expect(extractErrorCode(42)).toBeNull();
  });

  it('handles plain objects with code', () => {
    expect(extractErrorCode({ code: 'NET_FAIL' })).toBe('NET_FAIL');
  });
});

function defaultState(overrides?: Partial<RecoveryState>): RecoveryState {
  return {
    mode: 'normal',
    reason: null,
    updateState: 'idle',
    updateVersion: null,
    lastUpdateError: null,
    lastCheckResult: null,
    autoRetry: null,
    ...overrides,
  };
}

describe('buildTrayMenuTemplate', () => {
  it('includes Show/Hide/Change Instance/Quit base items', () => {
    const items = buildTrayMenuTemplate(defaultState());
    const labels = items.map((i) => i.label);
    expect(labels).toContain('Show Backspace');
    expect(labels).toContain('Hide');
    expect(labels).toContain('Change Instance');
    expect(labels).toContain('Quit');
  });

  it('includes Check for Updates with idle label when updateState=idle', () => {
    const items = buildTrayMenuTemplate(defaultState({ updateState: 'idle' }));
    const item = items.find((i) => i.id === 'check-for-updates');
    expect(item).toBeDefined();
    expect(item!.label).toBe('Check for Updates…');
    expect(item!.enabled).toBe(true);
  });

  it('disables Check for Updates while checking', () => {
    const items = buildTrayMenuTemplate(defaultState({ updateState: 'checking' }));
    const item = items.find((i) => i.id === 'check-for-updates');
    expect(item!.label).toBe('Checking for Updates…');
    expect(item!.enabled).toBe(false);
  });

  it('disables Check for Updates while downloading', () => {
    const items = buildTrayMenuTemplate(defaultState({ updateState: 'downloading' }));
    const item = items.find((i) => i.id === 'check-for-updates');
    expect(item!.label).toBe('Downloading Update…');
    expect(item!.enabled).toBe(false);
  });

  it('shows Update Ready label when downloaded, with Check disabled (Restart is the action)', () => {
    const items = buildTrayMenuTemplate(defaultState({ updateState: 'downloaded' }));
    const item = items.find((i) => i.id === 'check-for-updates');
    expect(item!.label).toBe('Update Ready');
    expect(item!.enabled).toBe(false);
  });

  it('shows error suffix on Check for Updates label when updateState=error', () => {
    const items = buildTrayMenuTemplate(defaultState({ updateState: 'error' }));
    const item = items.find((i) => i.id === 'check-for-updates');
    expect(item!.label).toBe('Check for Updates… (last attempt failed)');
    expect(item!.enabled).toBe(true);
  });

  it('inserts Restart to Install Update only when updateState=downloaded', () => {
    expect(
      buildTrayMenuTemplate(defaultState({ updateState: 'idle' })).find((i) => i.id === 'restart-to-install'),
    ).toBeUndefined();
    expect(
      buildTrayMenuTemplate(defaultState({ updateState: 'downloading' })).find((i) => i.id === 'restart-to-install'),
    ).toBeUndefined();
    const downloadedItem = buildTrayMenuTemplate(defaultState({ updateState: 'downloaded' }))
      .find((i) => i.id === 'restart-to-install');
    expect(downloadedItem).toBeDefined();
    expect(downloadedItem!.label).toBe('Restart to Install Update');
    expect(downloadedItem!.enabled).toBe(true);
  });

  it('omits updater actions when updates are managed externally', () => {
    const items = buildTrayMenuTemplate(defaultState({ updateState: 'external' }));
    expect(items.find((i) => i.id === 'check-for-updates')).toBeUndefined();
    expect(items.find((i) => i.id === 'restart-to-install')).toBeUndefined();
  });
});

describe('buildAppMenuTemplate', () => {
  it('returns top-level menu with App, Edit, Window submenus', () => {
    const template = buildAppMenuTemplate('Backspace', defaultState());
    const [appMenu, editMenu, windowMenu] = template;
    expect(template.length).toBeGreaterThanOrEqual(3);
    expect(appMenu!.label).toBe('Backspace');
    expect(editMenu!.label).toBe('Edit');
    expect(windowMenu!.label).toBe('Window');
  });

  it('App submenu includes About and Change Instance', () => {
    const template = buildAppMenuTemplate('Backspace', defaultState());
    const [appMenu] = template;
    const appSub = appMenu!.submenu as MenuItemConstructorOptions[];
    const labels = appSub.map((i) => i.label).filter(Boolean);
    expect(appSub.find((i) => i.role === 'about')).toBeDefined();
    expect(labels).toContain('Change Instance');
    expect(appSub.find((i) => i.role === 'quit')).toBeDefined();
  });

  it('App submenu includes Check for Updates with state-correct label', () => {
    const template = buildAppMenuTemplate('Backspace', defaultState({ updateState: 'idle' }));
    const [appMenu] = template;
    const appSub = appMenu!.submenu as MenuItemConstructorOptions[];
    const item = appSub.find((i) => i.id === 'check-for-updates');
    expect(item).toBeDefined();
    expect(item!.label).toBe('Check for Updates…');
  });

  it('App submenu inserts Restart to Install Update only when downloaded', () => {
    const [idleAppMenu] = buildAppMenuTemplate('Backspace', defaultState({ updateState: 'idle' }));
    const idleSub = idleAppMenu!.submenu as MenuItemConstructorOptions[];
    expect(idleSub.find((i) => i.id === 'restart-to-install')).toBeUndefined();

    const [dlAppMenu] = buildAppMenuTemplate('Backspace', defaultState({ updateState: 'downloaded' }));
    const dlSub = dlAppMenu!.submenu as MenuItemConstructorOptions[];
    const restartItem = dlSub.find((i) => i.id === 'restart-to-install');
    expect(restartItem).toBeDefined();
    expect(restartItem!.label).toBe('Restart to Install Update');
  });

  it('App submenu omits updater actions when updates are managed externally', () => {
    const [appMenu] = buildAppMenuTemplate('Backspace', defaultState({ updateState: 'external' }));
    const appSub = appMenu!.submenu as MenuItemConstructorOptions[];
    expect(appSub.find((i) => i.id === 'check-for-updates')).toBeUndefined();
    expect(appSub.find((i) => i.id === 'restart-to-install')).toBeUndefined();
  });
});

interface FakeWebContents { getURL: () => string }
interface FakeWindow { webContents: FakeWebContents; isDestroyed: () => boolean }

function fakeWin(url: string): FakeWindow {
  return { webContents: { getURL: () => url }, isDestroyed: () => false };
}

describe('armBootTimer / clearBootTimer', () => {
  beforeEach(() => {
    // Reset all module-level boot-timer state including pingReceivedThisNav so
    // tests that call handleRendererReady() don't pollute subsequent tests.
    resetBootTimerStateForTest();
  });

  it('arms when URL is http://', () => {
    armBootTimer(fakeWin('http://localhost:3005/') as never);
    expect(isBootArmed()).toBe(true);
    clearBootTimer();
  });

  it('arms when URL is https://', () => {
    armBootTimer(fakeWin('https://example.com/') as never);
    expect(isBootArmed()).toBe(true);
    clearBootTimer();
  });

  it('skips file:// URLs', () => {
    armBootTimer(fakeWin('file:///path/to/recovery.html') as never);
    expect(isBootArmed()).toBe(false);
  });

  it('skips empty URLs', () => {
    armBootTimer(fakeWin('') as never);
    expect(isBootArmed()).toBe(false);
  });

  it('clearBootTimer disarms', () => {
    armBootTimer(fakeWin('http://localhost/') as never);
    expect(isBootArmed()).toBe(true);
    clearBootTimer();
    expect(isBootArmed()).toBe(false);
  });

  it('does NOT arm if rendererReady arrived before armBootTimer (early-ping case)', () => {
    // Simulate SPA timing: useEffect fires (microtask) before did-finish-load.
    // The ping arrives when bootArmed=false, then armBootTimer is called by
    // did-finish-load. Without the pingReceivedThisNav flag this would arm a
    // 20s timer that nothing clears → false renderer-stalled recovery.
    handleRendererReady();
    armBootTimer(fakeWin('http://localhost:3005/') as never);
    expect(isBootArmed()).toBe(false);
  });

  it('clears existing timer if rendererReady arrives after armBootTimer (late-ping case)', () => {
    // Simulate the less-common ordering: did-finish-load fires first (arms timer),
    // then the ping arrives. Preserved existing behavior — ping clears the timer.
    armBootTimer(fakeWin('http://localhost:3005/') as never);
    expect(isBootArmed()).toBe(true);
    handleRendererReady();
    expect(isBootArmed()).toBe(false);
  });

  it('flag is per-navigation: after clearBootTimer reset, a subsequent arm should still be blocked by the set flag', () => {
    // Verify that pingReceivedThisNav persists across clearBootTimer calls until
    // a real did-navigate resets it. The module-level flag is only reset by
    // did-navigate (wired in attachRecoveryHandlers). Here we confirm the flag
    // behaviour in isolation: ping → arm (blocked) → clear → arm again (still blocked).
    // The per-nav reset is integration-tested by smoke scenario 4 + 13 together.
    handleRendererReady();
    armBootTimer(fakeWin('http://localhost:3005/') as never);
    expect(isBootArmed()).toBe(false);
    // clearBootTimer resets bootArmed but NOT pingReceivedThisNav
    clearBootTimer();
    armBootTimer(fakeWin('http://localhost:3005/') as never);
    expect(isBootArmed()).toBe(false);
  });
});

describe('manual-download update state in the menus', () => {
  it('offers a versioned Download item instead of Restart to Install', () => {
    // An ad-hoc signed macOS build. Restart to Install would be a dead button
    // here, because Squirrel.Mac can never satisfy the running app's
    // cdhash-literal designated requirement.
    const items = buildTrayMenuTemplate(
      defaultState({ updateState: 'available-manual', updateVersion: '1.0.4' }),
    );
    const ids = items.map((i) => i.id);
    expect(ids).toContain('download-update');
    expect(ids).not.toContain('restart-to-install');
    expect(items.find((i) => i.id === 'download-update')!.label)
      .toBe('Download Backspace 1.0.4…');
  });

  it('falls back to an unversioned label when no version is known', () => {
    const items = buildTrayMenuTemplate(
      defaultState({ updateState: 'available-manual', updateVersion: null }),
    );
    expect(items.find((i) => i.id === 'download-update')!.label)
      .toBe('Download the Update…');
  });

  it('wires the Download item to the open-releases action', () => {
    let opened = 0;
    const items = buildTrayMenuTemplate(
      defaultState({ updateState: 'available-manual', updateVersion: '1.0.4' }),
      { onOpenReleases: () => { opened += 1; } },
    );
    (items.find((i) => i.id === 'download-update')!.click as () => void)();
    expect(opened).toBe(1);
  });

  it('disables Check for Updates while an update is already known', () => {
    const items = buildTrayMenuTemplate(defaultState({ updateState: 'available-manual' }));
    const check = items.find((i) => i.id === 'check-for-updates')!;
    expect(check.label).toBe('Update Available');
    expect(check.enabled).toBe(false);
  });

  it('applies the same treatment to the macOS app menu', () => {
    const template = buildAppMenuTemplate(
      'Backspace',
      defaultState({ updateState: 'available-manual', updateVersion: '1.0.4' }),
    );
    const appSubmenu = template[0]!.submenu as Array<{ id?: string; label?: string }>;
    const ids = appSubmenu.map((i) => i.id);
    expect(ids).toContain('download-update');
    expect(ids).not.toContain('restart-to-install');
  });

  it('still offers Restart to Install when the update really is staged', () => {
    const items = buildTrayMenuTemplate(
      defaultState({ updateState: 'downloaded', updateVersion: '1.0.4' }),
    );
    const ids = items.map((i) => i.id);
    expect(ids).toContain('restart-to-install');
    expect(ids).not.toContain('download-update');
  });
});

describe('confirmation-first automatic update state in the menus', () => {
  it('offers a versioned Download item wired to the in-app action', () => {
    const download = vi.fn();
    const openReleases = vi.fn();
    const items = buildTrayMenuTemplate(
      defaultState({ updateState: 'available-auto', updateVersion: '1.3.3' }),
      { onDownloadUpdate: download, onOpenReleases: openReleases },
    );
    const item = items.find((entry) => entry.id === 'download-update');
    expect(item?.label).toBe('Download Backspace 1.3.3…');
    (item?.click as () => void)();
    expect(download).toHaveBeenCalledOnce();
    expect(openReleases).not.toHaveBeenCalled();
  });

  it('disables another update check while confirmation is pending', () => {
    const items = buildTrayMenuTemplate(defaultState({ updateState: 'available-auto' }));
    expect(items.find((entry) => entry.id === 'check-for-updates')).toMatchObject({
      label: 'Update Available',
      enabled: false,
    });
  });
});

// ── Load-failure classification ───────────────────────────────────────────

describe('load-failure classification', () => {
  it('classifies transport-level errors as transient', () => {
    expect(isTransientLoadFailure(-105)).toBe(true); // ERR_NAME_NOT_RESOLVED
    expect(isTransientLoadFailure(-102)).toBe(true); // ERR_CONNECTION_REFUSED
    expect(isTransientLoadFailure(-7)).toBe(true);   // ERR_TIMED_OUT
    expect(isTransientLoadFailure(-106)).toBe(true); // ERR_INTERNET_DISCONNECTED
    expect(isTransientLoadFailure(-324)).toBe(true); // ERR_EMPTY_RESPONSE
  });

  it('treats deterministic failures as permanent', () => {
    expect(isTransientLoadFailure(-6)).toBe(false);   // ERR_FILE_NOT_FOUND
    expect(isTransientLoadFailure(-10)).toBe(false);  // ERR_ACCESS_DENIED
    expect(isTransientLoadFailure(-202)).toBe(false); // ERR_CERT_AUTHORITY_INVALID
    expect(isTransientLoadFailure(0)).toBe(false);
  });

  it('only retries http(s) navigations', () => {
    expect(isRetryableNavigation('https://chat.example.test/')).toBe(true);
    expect(isRetryableNavigation('http://localhost:3000')).toBe(true);
    expect(isRetryableNavigation('file:///C:/app/resources/recovery.html')).toBe(false);
    expect(isRetryableNavigation('about:blank')).toBe(false);
  });

  it('backs off exponentially and caps the delay', () => {
    expect(nextAutoRetryDelayMs(1)).toBe(2_000);
    expect(nextAutoRetryDelayMs(2)).toBe(4_000);
    expect(nextAutoRetryDelayMs(3)).toBe(8_000);
    expect(nextAutoRetryDelayMs(4)).toBe(15_000);
    expect(nextAutoRetryDelayMs(99)).toBe(15_000);
    expect(nextAutoRetryDelayMs(0)).toBe(2_000);
    expect(nextAutoRetryDelayMs(Number.NaN)).toBe(2_000);
  });
});

// ── Automatic reconnect ───────────────────────────────────────────────────

interface RetryFakeWindow {
  isDestroyed: () => boolean;
  loadURL: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  webContents: {
    on: (event: string, handler: (...args: unknown[]) => void) => void;
    getURL: () => string;
  };
}

function makeRetryWindow(
  handlers: Map<string, Array<(...args: unknown[]) => void>> = new Map(),
  currentUrl = '',
  destroyed = false,
): RetryFakeWindow {
  return {
    isDestroyed: () => destroyed,
    loadURL: vi.fn(() => Promise.resolve()),
    loadFile: vi.fn(() => Promise.resolve()),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: {
      on: (event, handler) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      getURL: () => currentUrl,
    },
  };
}

function resetRecoveryState(): void {
  stopAutoRetry();
  recoveryStore.markRecoveryExited();
  recoveryStore.update({ mode: 'normal', reason: null, autoRetry: null });
  setReachabilityProbe(null);
  setMainWindow(null);
}

describe('automatic reconnect while recovery is showing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRecoveryState();
  });

  afterEach(() => {
    resetRecoveryState();
    vi.useRealTimers();
  });

  it('probes with backoff and reloads the app once the instance answers', async () => {
    const win = makeRetryWindow();
    setMainWindow(win as unknown as BrowserWindow);
    let reachable = false;
    setReachabilityProbe(() => Promise.resolve(reachable));

    startAutoRetry('https://chat.example.test/');
    expect(isAutoRetryActive()).toBe(true);
    expect(recoveryStore.get().autoRetry?.attempt).toBe(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(win.loadURL).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);      // attempt 1 runs, instance still down
    expect(recoveryStore.get().autoRetry?.attempt).toBe(2);

    await vi.advanceTimersByTimeAsync(4_000);  // attempt 2 runs, still down
    expect(recoveryStore.get().autoRetry?.attempt).toBe(3);

    reachable = true;
    await vi.advanceTimersByTimeAsync(8_000);  // attempt 3 succeeds
    expect(win.loadURL).toHaveBeenCalledWith('https://chat.example.test/');
    expect(isAutoRetryActive()).toBe(false);
    expect(recoveryStore.get().autoRetry).toBeNull();
    expect(recoveryStore.get().mode).toBe('normal');
  });

  it('stops without navigating when the window is gone', async () => {
    const win = makeRetryWindow(new Map(), '', true);
    setMainWindow(win as unknown as BrowserWindow);
    setReachabilityProbe(() => Promise.resolve(true));

    startAutoRetry('https://chat.example.test/');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(win.loadURL).not.toHaveBeenCalled();
    expect(isAutoRetryActive()).toBe(false);
    expect(recoveryStore.get().autoRetry).toBeNull();
  });

  it('a manual action cancels the loop', async () => {
    const win = makeRetryWindow();
    setMainWindow(win as unknown as BrowserWindow);
    setReachabilityProbe(() => Promise.resolve(true));

    startAutoRetry('https://chat.example.test/');
    stopAutoRetry();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(win.loadURL).not.toHaveBeenCalled();
    expect(isAutoRetryActive()).toBe(false);
  });

  it('refuses non-http targets so file:// surfaces cannot loop', () => {
    startAutoRetry('file:///C:/app/resources/recovery.html');
    expect(isAutoRetryActive()).toBe(false);
    expect(recoveryStore.get().autoRetry).toBeNull();
  });
});

describe('load-failure handling in attachRecoveryHandlers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRecoveryState();
  });

  afterEach(() => {
    resetRecoveryState();
    vi.useRealTimers();
  });

  it('absorbs one transient failure silently, then escalates to recovery', async () => {
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const win = makeRetryWindow(handlers);
    setMainWindow(win as unknown as BrowserWindow);
    attachRecoveryHandlers(win as unknown as BrowserWindow);

    const failLoad = handlers.get('did-fail-load')?.[0];
    expect(failLoad).toBeDefined();

    // First failure: still invisible to the user, a silent retry is scheduled.
    failLoad!({}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://chat.example.test/', true);
    expect(recoveryStore.get().mode).toBe('normal');
    expect(win.loadFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(750);
    expect(win.loadURL).toHaveBeenCalledWith('https://chat.example.test/');

    // Second failure: the silent budget is spent, recovery takes over.
    failLoad!({}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://chat.example.test/', true);
    expect(recoveryStore.get().mode).toBe('recovery');
    expect(recoveryStore.get().reason?.code).toBe('load-failed');
    expect(win.loadFile).toHaveBeenCalledTimes(1);
    // The reconnect loop for the instance URL runs behind the dialog.
    expect(isAutoRetryActive()).toBe(true);
  });

  it('goes straight to recovery for a deterministic failure', () => {
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const win = makeRetryWindow(handlers);
    setMainWindow(win as unknown as BrowserWindow);
    attachRecoveryHandlers(win as unknown as BrowserWindow);

    handlers.get('did-fail-load')![0]!({}, -202, 'ERR_CERT_AUTHORITY_INVALID', 'https://chat.example.test/', true);
    expect(recoveryStore.get().mode).toBe('recovery');
    expect(win.loadURL).not.toHaveBeenCalled();
  });

  it('ignores sub-frame failures and intentional aborts', () => {
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const win = makeRetryWindow(handlers);
    setMainWindow(win as unknown as BrowserWindow);
    attachRecoveryHandlers(win as unknown as BrowserWindow);
    const failLoad = handlers.get('did-fail-load')![0]!;

    failLoad({}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://chat.example.test/', false);
    failLoad({}, -3, 'ERR_ABORTED', 'https://chat.example.test/', true);

    expect(recoveryStore.get().mode).toBe('normal');
  });

  it('a healthy application load clears the failure state', () => {
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const win = makeRetryWindow(handlers, 'https://chat.example.test/');
    setMainWindow(win as unknown as BrowserWindow);
    attachRecoveryHandlers(win as unknown as BrowserWindow);

    startAutoRetry('https://chat.example.test/');
    expect(isAutoRetryActive()).toBe(true);

    handlers.get('did-finish-load')![0]!();
    expect(isAutoRetryActive()).toBe(false);
    expect(recoveryStore.get().autoRetry).toBeNull();
  });
});
