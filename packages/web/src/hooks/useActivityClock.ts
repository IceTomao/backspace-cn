import { useSyncExternalStore } from 'react';
import { isAndroid, onAndroid } from '../platform/android';

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
let nativeVisible = true;
let removeNativeVisibility: (() => void) | undefined;
function publish() { now = Date.now(); listeners.forEach(listener => listener()); }
function visibility() {
  if (timer !== null) clearInterval(timer);
  timer = null;
  if (!document.hidden && nativeVisible && listeners.size) { publish(); timer = setInterval(publish, 15_000); }
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', visibility);
    if (isAndroid()) removeNativeVisibility = onAndroid<{ visible: boolean }>('webVisibility', ({ visible }) => { nativeVisible = visible; visibility(); });
    visibility();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      document.removeEventListener('visibilitychange', visibility);
      removeNativeVisibility?.(); removeNativeVisibility = undefined;
      nativeVisible = true;
      visibility();
    }
  };
}
const idleSubscribe = () => () => {};
export function useActivityClock(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : idleSubscribe, () => now, () => now);
}
