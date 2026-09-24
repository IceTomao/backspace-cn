/// <reference lib="dom" />
import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { startDesktopFavorites } from './favoritesPreload';

const startFavorites = () => {
  try { startDesktopFavorites(); } catch (error) {
    console.warn('[favorites] Desktop adapter unavailable:', error);
  }
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startFavorites, { once: true });
} else {
  startFavorites();
}

// Keep the packaged client compatible with instances that still serve the old
// Chinese timestamp resources. Updated instances no longer match this pattern.
const startChineseMessageTimestampAdapter = () => {
  if (process.platform !== 'win32' || !process.isMainFrame ||
      !['https:', 'http:'].includes(window.location.protocol)) return;
  let frame = 0;
  let stopped = false;
  const rewrite = () => {
    frame = 0;
    if (stopped || document.documentElement.dataset.theme !== 'aether-drift') return;
    document.querySelectorAll<HTMLElement>('[id^="msg-"] span').forEach((element) => {
      if (!element.classList.contains('text-[11px]') ||
          !element.classList.contains('text-txt-tertiary') ||
          !element.classList.contains('leading-tight')) return;
      const match = element.textContent?.match(/^(\u4eca\u5929|\u6628\u5929)\u5728(\d{1,2}:\d{2})$/);
      if (match) element.textContent = `${match[1]}${match[2]}`;
    });
  };
  const schedule = () => {
    if (!frame && !stopped) frame = window.requestAnimationFrame(rewrite);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  rewrite();
  window.addEventListener('pagehide', () => {
    stopped = true;
    observer.disconnect();
    window.cancelAnimationFrame(frame);
  }, { once: true });
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startChineseMessageTimestampAdapter, { once: true });
} else {
  startChineseMessageTimestampAdapter();
}

// Synchronous bootstrap of a fixed bundled stylesheet avoids an IPC round trip
// after the first paint. This private channel is not exposed through the bridge.
if (process.platform === 'win32' && process.isMainFrame) {
  try {
    const styles: unknown = ipcRenderer.sendSync('desktop-theme-styles');
    if (typeof styles === 'string' && styles) {
      webFrame.insertCSS(styles, { cssOrigin: 'user' });
    }
  } catch (error) {
    console.warn('[theme] Theme bootstrap unavailable:', error);
  }
}

// The settings UI is hosted remotely. Add a desktop-owned control in the
// isolated preload without exposing theme mutation on the webpage bridge.
if (process.platform === 'win32' && process.isMainFrame &&
    (window.location.protocol === 'https:' || window.location.protocol === 'http:')) {
  const startThemeSettings = () => {
    type Mode = 'system' | 'light' | 'dark';
    const validMode = (value: unknown): value is Mode =>
      value === 'system' || value === 'light' || value === 'dark';
    const labels = {
      en: {
        title: 'Theme', system: 'Follow system', light: 'Light', dark: 'Dark',
        failed: 'Could not save the theme preference. Your previous selection is unchanged.',
        unavailable: 'Theme settings are unavailable. Try reopening Settings.',
      },
      zh: {
        title: '\u4e3b\u9898', system: '\u8ddf\u968f\u7cfb\u7edf',
        light: '\u6d45\u8272', dark: '\u6df1\u8272',
        failed: '\u65e0\u6cd5\u4fdd\u5b58\u4e3b\u9898\u8bbe\u7f6e\uff0c\u5df2\u4fdd\u7559\u539f\u6765\u7684\u9009\u62e9\u3002',
        unavailable: '\u4e3b\u9898\u8bbe\u7f6e\u6682\u4e0d\u53ef\u7528\uff0c\u8bf7\u91cd\u65b0\u6253\u5f00\u8bbe\u7f6e\u3002',
      },
      de: {
        title: 'Design', system: 'Systemeinstellung', light: 'Hell', dark: 'Dunkel',
        failed: 'Die Einstellung konnte nicht gespeichert werden. Die vorherige Auswahl bleibt bestehen.',
        unavailable: 'Designeinstellungen nicht verfuegbar. Einstellungen erneut oeffnen.',
      },
      ru: {
        title: '\u0422\u0435\u043c\u0430', system: '\u041a\u0430\u043a \u0432 \u0441\u0438\u0441\u0442\u0435\u043c\u0435',
        light: '\u0421\u0432\u0435\u0442\u043b\u0430\u044f', dark: '\u0422\u0451\u043c\u043d\u0430\u044f',
        failed: '\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0441\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c \u0442\u0435\u043c\u0443.',
        unavailable: '\u041e\u0442\u043a\u0440\u043e\u0439\u0442\u0435 \u043d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438 \u043f\u043e\u0432\u0442\u043e\u0440\u043d\u043e.',
      },
    };
    const section = document.createElement('div');
    section.id = 'backspace-desktop-theme-section';
    const label = document.createElement('label');
    label.htmlFor = 'backspace-desktop-theme';
    label.className = 'block text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5';
    const surface = document.createElement('div');
    surface.className = 'rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5';
    const select = document.createElement('select');
    select.id = label.htmlFor;
    select.className = 'input-standard w-full';
    select.disabled = true;
    const options = (['system', 'light', 'dark'] as const).map((mode) => {
      const option = document.createElement('option');
      option.value = mode;
      select.appendChild(option);
      return option;
    });
    const error = document.createElement('p');
    error.id = 'backspace-desktop-theme-error';
    error.className = 'text-xs text-txt-danger mt-2';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    select.setAttribute('aria-describedby', error.id);
    surface.append(select, error);
    section.append(label, surface);
    let mode: Mode = 'system';
    let ready = false;
    let saving = false;
    let stopped = false;
    let message: 'failed' | 'unavailable' | null = null;
    let frame = 0;
    let revision = 0;

    const render = () => {
      const language = document.querySelector<HTMLSelectElement>('#language-select')?.value ?? document.documentElement.lang;
      const text = labels[language as keyof typeof labels] ?? labels.en;
      if (label.textContent !== text.title) label.textContent = text.title;
      for (const option of options) {
        const value = text[option.value as Mode];
        if (option.textContent !== value) option.textContent = value;
      }
      select.value = mode;
      select.disabled = !ready || saving;
      const errorText = message ? text[message] : '';
      if (error.textContent !== errorText) error.textContent = errorText;
      error.hidden = !message;
    };

    const refresh = async () => {
      const currentRevision = revision;
      try {
        const stored: unknown = await ipcRenderer.invoke('desktop-theme-get');
        if (stopped || currentRevision !== revision) return;
        if (!validMode(stored)) throw new Error('Invalid theme');
        mode = stored;
        ready = true;
        message = null;
      } catch {
        if (stopped || currentRevision !== revision) return;
        ready = false;
        message = 'unavailable';
      }
      render();
    };

    const mount = () => {
      frame = 0;
      if (stopped) return;
      const scaleSection = document.querySelector('label[for="interface-scale"]')?.parentElement;
      const panel = scaleSection?.parentElement;
      const matches = document.documentElement.dataset.theme === 'aether-drift' &&
        panel?.querySelector('#language-select') && panel.querySelector('h2');
      if (!matches || !scaleSection || !panel) {
        section.remove();
        return;
      }
      if (section.parentElement !== panel) {
        panel.insertBefore(section, scaleSection);
        void refresh();
      }
      render();
    };
    const schedule = () => {
      if (!frame && !stopped) frame = window.requestAnimationFrame(mount);
    };
    select.addEventListener('change', async (event) => {
      // A page script dispatching a DOM event must not change desktop settings.
      if (!event.isTrusted || !ready || saving || !section.isConnected || !validMode(select.value)) {
        render();
        return;
      }
      const selected = select.value;
      saving = true;
      message = null;
      revision++;
      render();
      try {
        const result: unknown = await ipcRenderer.invoke('desktop-theme-set', selected);
        if (stopped) return;
        if (!result || typeof result !== 'object' || !('mode' in result) ||
            !validMode(result.mode) || !('ok' in result) || typeof result.ok !== 'boolean') {
          throw new Error('Invalid theme response');
        }
        mode = result.mode;
        message = result.ok ? null : 'failed';
      } catch {
        message = 'failed';
      } finally {
        saving = false;
        if (!stopped) render();
      }
    });
    const onThemeChanged = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (!validMode(value)) return;
      revision++;
      mode = value;
      ready = true;
      message = null;
      render();
    };
    ipcRenderer.on('desktop-theme-changed', onThemeChanged);
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['lang', 'data-theme'],
    });
    document.addEventListener('change', schedule);
    mount();
    window.addEventListener('pagehide', () => {
      stopped = true;
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      document.removeEventListener('change', schedule);
      ipcRenderer.removeListener('desktop-theme-changed', onThemeChanged);
    }, { once: true });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startThemeSettings, { once: true });
  } else {
    startThemeSettings();
  }
}

// Sandboxed preloads cannot require local modules. Main supplies this public
// preference through additionalArguments before any remote page script runs.
try {
  if (window.location.protocol === 'https:' || window.location.protocol === 'http:') {
    const language = process.argv.find((arg) => arg.startsWith('--backspace-default-language='))?.split('=')[1];
    if (language && window.localStorage.getItem('backspace-language') === null) {
      window.localStorage.setItem('backspace-language', language);
    }
  }
} catch {
  // A blocked storage area must not prevent the desktop bridge from loading.
}

contextBridge.exposeInMainWorld('backspace', {
  // Platform info
  platform: process.platform,
  // Window controls
  minimize: () => {
    ipcRenderer.send('minimize-window');
  },
  maximize: () => {
    ipcRenderer.send('maximize-window');
  },
  close: () => {
    ipcRenderer.send('close-window');
  },

  // Notifications & badge
  showNotification: (title: string, body: string, options?: { channelId?: string; spaceId?: string; userId?: string }) => {
    ipcRenderer.send('show-notification', { title, body, options });
  },
  onNotificationClick: (callback: (options: { channelId?: string; spaceId?: string; userId?: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, options: { channelId?: string; spaceId?: string; userId?: string }) => callback(options);
    ipcRenderer.on('notification-click', handler);
    return () => { ipcRenderer.removeListener('notification-click', handler); };
  },
  setBadgeCount: (count: number) => {
    ipcRenderer.send('set-badge-count', count);
  },

  // Auto-update, legacy per-event channels.
  //
  // Superseded by getUpdateStatus/onUpdateStatusChanged below and unused by the
  // current web client, but deliberately kept. The desktop app and the instance
  // it connects to version independently: a newer app can be pointed at an older
  // instance that still serves a client calling these. Removing them would make
  // that client throw inside a useEffect and take the whole renderer down.
  onUpdateAvailable: (callback: (info: { version: string }) => void) => {
    ipcRenderer.on('update-available', (_event, info) => callback(info));
  },
  onUpdateDownloaded: (callback: (info: { version: string }) => void) => {
    ipcRenderer.on('update-downloaded', (_event, info) => callback(info));
  },
  onUpdateError: (callback: (error: { message: string; releaseUrl: string }) => void) => {
    ipcRenderer.on('update-error', (_event, error) => callback(error));
  },
  installUpdate: () => {
    ipcRenderer.send('install-update');
  },
  checkForUpdates: () => {
    ipcRenderer.send('check-for-updates');
  },
  downloadUpdate: () => {
    ipcRenderer.send('download-update');
  },
  getVersion: () => ipcRenderer.invoke('get-app-version'),

  // Auto-update, current surface. One snapshot carrying the capability of this
  // build, the version the user has already waved away, and the current status.
  getUpdateStatus: (): Promise<unknown> => ipcRenderer.invoke('get-update-status'),
  isSandboxed: (): Promise<boolean> => ipcRenderer.invoke('is-sandboxed'),

  onUpdateStatusChanged: (callback: (snapshot: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: unknown) => callback(snapshot);
    ipcRenderer.on('update-status-changed', handler);
    return () => { ipcRenderer.removeListener('update-status-changed', handler); };
  },

  dismissUpdate: (version: string): void => {
    ipcRenderer.send('dismiss-update', { version });
  },

  openReleasePage: (): void => {
    ipcRenderer.send('open-release-page');
  },

  // Window focus
  onWindowFocusChange: (callback: (focused: boolean) => void) => {
    ipcRenderer.on('window-focus-changed', (_event, focused) => callback(focused));
  },

  // Deep linking
  onDeepLink: (callback: (url: string) => void) => {
    ipcRenderer.on('deep-link', (_event, url) => callback(url));
  },

  // Instance-origin-aware URL routing
  setConnectedOrigins: (origins: string[]) => {
    ipcRenderer.send('set-connected-origins', origins);
  },
  onOpenInternalRoute: (callback: (path: string) => void) => {
    const handler = (_evt: Electron.IpcRendererEvent, path: string) => callback(path);
    ipcRenderer.on('open-internal-route', handler);
    return () => { ipcRenderer.removeListener('open-internal-route', handler); };
  },

  // Screen share picker coordination
  onScreenShareSources: (callback: (sources: unknown[]) => void) => {
    ipcRenderer.on('screen-share-sources', (_event, sources) => callback(sources));
  },
  selectScreenSource: (sourceId: string | null, shareAudio?: boolean) => {
    ipcRenderer.send('screen-share-selected', sourceId, shareAudio ?? true);
  },
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  // invoke, not send: the renderer must know the preselection has landed in the
  // main process before it calls getDisplayMedia(), or the two race.
  preselectScreenSource: (sourceId: string, shareAudio?: boolean) =>
    ipcRenderer.invoke('screen-share-preselect', sourceId, shareAudio ?? true),
  getScreenSharePickerMode: () => ipcRenderer.invoke('get-screen-share-picker-mode'),
  setScreenShareAudioPreference: (shareAudio: boolean) => {
    ipcRenderer.send('screen-share-audio-preference', shareAudio);
  },

  // Instance URL management
  getInstanceUrl: () => ipcRenderer.invoke('get-instance-url'),
  setInstanceUrl: (url: string) => ipcRenderer.invoke('set-instance-url', url),
  clearInstanceUrl: () => ipcRenderer.invoke('clear-instance-url'),

  // Language: the renderer owns the choice; main relabels its tray and menus.
  setLanguage: (language: string) => ipcRenderer.send('set-language', language),

  // Auto-launch settings
  getAutoLaunchSettings: () => ipcRenderer.invoke('get-auto-launch-settings'),
  setAutoLaunchSettings: (settings: { openAtLogin?: boolean; startMinimized?: boolean }) =>
    ipcRenderer.invoke('set-auto-launch-settings', settings),

  // Activity detection (game/app process scanning)
  onActivityDetected: (callback: (activity: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, activity: unknown) => callback(activity);
    ipcRenderer.on('activity-detected', handler);
    return () => { ipcRenderer.removeListener('activity-detected', handler); };
  },
  getCurrentActivity: () => ipcRenderer.invoke('get-current-activity'),
  onActivitiesDetected: (callback: (activities: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, activities: unknown[]) => callback(activities);
    ipcRenderer.on('activities-detected', handler);
    return () => { ipcRenderer.removeListener('activities-detected', handler); };
  },
  getCurrentActivities: () => ipcRenderer.invoke('get-current-activities'),
  getActivityPreferences: () => ipcRenderer.invoke('get-activity-preferences'),
  setActivityPreferences: (preferences: { showGames?: boolean; showMusic?: boolean; showActivityImages?: boolean }) =>
    ipcRenderer.invoke('set-activity-preferences', preferences),
  setActivityAssetSession: (session: { token: string | null; enabled: boolean }) =>
    ipcRenderer.invoke('set-activity-asset-session', session),

  // Keybind support
  getKeybindPortalStatus: () => ipcRenderer.invoke('keybind-portal-status'),
  retryKeybindPortal: () => ipcRenderer.send('keybind-portal-retry'),
  onKeybindPortalStatus: (callback: (status: import('./portalShortcut').PortalKeybindStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: import('./portalShortcut').PortalKeybindStatus) => callback(status);
    ipcRenderer.on('keybind-portal-status', handler);
    return () => { ipcRenderer.removeListener('keybind-portal-status', handler); };
  },
  syncKeybinds: (keybinds: Array<{ actionId: string; keys: number[]; mouseButton?: number }>) => {
    return ipcRenderer.invoke('keybinds-sync', keybinds);
  },
  onKeybindAction: (callback: (action: { actionId: string; pressed: boolean }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: { actionId: string; pressed: boolean }) => callback(action);
    ipcRenderer.on('keybind-action', handler);
    return () => { ipcRenderer.removeListener('keybind-action', handler); };
  },
  onAccessibilityStatus: (callback: (status: { trusted: boolean }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: { trusted: boolean }) => callback(status);
    ipcRenderer.on('accessibility-status', handler);
    return () => { ipcRenderer.removeListener('accessibility-status', handler); };
  },
  onKeybindHookError: (callback: (error: { message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: { message: string }) => callback(error);
    ipcRenderer.on('keybind-hook-error', handler);
    return () => { ipcRenderer.removeListener('keybind-hook-error', handler); };
  },
  checkAccessibility: () => ipcRenderer.invoke('check-accessibility'),

  // Recovery mode bridge (Task 11)
  rendererReady: (): void => {
    ipcRenderer.send('renderer-ready');
  },

  getRecoveryState: (): Promise<unknown> => {
    return ipcRenderer.invoke('get-recovery-state');
  },

  onRecoveryStateChanged: (cb: (state: unknown) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, state: unknown) => cb(state);
    ipcRenderer.on('recovery-state-changed', handler);
    return () => { ipcRenderer.removeListener('recovery-state-changed', handler); };
  },

  recoveryAction: (action: string): void => {
    ipcRenderer.send('recovery-action', action);
  },
});
