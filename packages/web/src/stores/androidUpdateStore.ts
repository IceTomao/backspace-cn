import { create } from 'zustand';
import { androidCall, isAndroid, onAndroid, type AndroidAppUpdateSnapshot } from '../platform/android';

export function coerceAndroidUpdate(value: unknown): AndroidAppUpdateSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (typeof data.currentVersion !== 'string' || !['idle', 'checking', 'available', 'up-to-date', 'unavailable', 'failed', 'unsupported'].includes(data.phase as string)) return null;
  if (data.version !== null && typeof data.version !== 'string') return null;
  if (data.dismissedVersion !== null && typeof data.dismissedVersion !== 'string') return null;
  if (data.phase === 'available' && (typeof data.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(data.version))) return null;
  return data as unknown as AndroidAppUpdateSnapshot;
}

let consumers = 0;
let removeListeners: (() => void)[] = [];
let nativeVisible = true;
let generation = 0;
interface AndroidUpdateStore {
  snapshot: AndroidAppUpdateSnapshot | null;
  initialize: () => () => void;
  check: (manual?: boolean) => Promise<void>;
  download: () => Promise<void>;
  dismiss: () => Promise<void>;
}
export const useAndroidUpdateStore = create<AndroidUpdateStore>((set, get) => {
  const apply = (value: unknown) => {
    const snapshot = coerceAndroidUpdate(value);
    const before = get().snapshot;
    if (snapshot && (!before || snapshot.currentVersion !== before.currentVersion || snapshot.phase !== before.phase ||
      snapshot.version !== before.version || snapshot.dismissedVersion !== before.dismissedVersion)) set({ snapshot });
  };
  return {
    snapshot: null,
    initialize: () => {
      if (!isAndroid()) return () => {};
      consumers++;
      if (consumers === 1) {
        const currentGeneration = ++generation;
        const visible = () => {
          if (nativeVisible && !document.hidden) void get().check(false);
        };
        document.addEventListener('visibilitychange', visible);
        removeListeners = [
          onAndroid<AndroidAppUpdateSnapshot>('appUpdate', apply),
          onAndroid<{ visible: boolean }>('webVisibility', (value) => { nativeVisible = value.visible; visible(); }),
          () => document.removeEventListener('visibilitychange', visible),
        ];
        void androidCall('appUpdateState').then(value => {
          if (generation !== currentGeneration) return;
          apply(value);
          visible();
        }).catch(() => {});
      }
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        if (--consumers === 0) {
          generation++;
          removeListeners.forEach(remove => remove()); removeListeners = [];
          nativeVisible = true;
        }
      };
    },
    check: async (manual = true) => {
      if (get().snapshot?.phase === 'checking') return;
      const before = get().snapshot;
      if (before) set({ snapshot: { ...before, phase: 'checking' } });
      try { apply(await androidCall('checkAppUpdate', { manual })); }
      catch {
        if (before) set({ snapshot: { ...before, phase: 'failed' } });
      }
    },
    download: async () => { await androidCall('downloadAppUpdate'); },
    dismiss: async () => { apply(await androidCall('dismissAppUpdate')); },
  };
});
