import type { Activity } from '@backspace/shared';
import { useActivityStore } from '../stores/activityStore';
import { useAuthStore } from '../stores/authStore';

let unsubscribe: (() => void) | null = null;
let unsubscribeSession: (() => void) | null = null;

function syncAssetSession(): void {
  const { token, user } = useAuthStore.getState();
  const enabled = useActivityStore.getState().showActivity && user?.showActivity !== false;
  void window.backspace?.setActivityAssetSession?.({ token, enabled: Boolean(token && enabled) }).catch(() => {});
}

export function initActivityBridge(): void {
  if (unsubscribe) return; // already initialized
  if (!window.backspace?.onActivityDetected) return; // not Electron
  syncAssetSession();
  unsubscribeSession = (() => {
    const auth = useAuthStore.subscribe((state, previous) => {
      if (state.token !== previous.token || state.user?.showActivity !== previous.user?.showActivity) syncAssetSession();
    });
    const activity = useActivityStore.subscribe((state, previous) => {
      if (state.showActivity !== previous.showActivity) syncAssetSession();
    });
    return () => { auth(); activity(); };
  })();

  if (window.backspace.onActivitiesDetected) {
    unsubscribe = window.backspace.onActivitiesDetected((activities) => {
      useActivityStore.getState().pushActivities(activities as Activity[]);
    });
    window.backspace.getCurrentActivities?.().then((activities: unknown) => {
      useActivityStore.getState().pushActivities(Array.isArray(activities) ? activities as Activity[] : []);
    }).catch(() => {});
    return;
  }

  // Subscribe to future activity changes from main process
  unsubscribe = window.backspace.onActivityDetected((activity) => {
    if (activity) {
      useActivityStore.getState().pushActivities([activity as Activity]);
    } else {
      useActivityStore.getState().pushActivities([]);
    }
  });

  // Request current state (handles instance-switch: game was already running)
  window.backspace.getCurrentActivity?.().then((activity: unknown) => {
    if (activity) {
      useActivityStore.getState().pushActivities([activity as Activity]);
    }
  }).catch(() => {});
}

export function teardownActivityBridge(): void {
  unsubscribe?.();
  unsubscribe = null;
  unsubscribeSession?.();
  unsubscribeSession = null;
  void window.backspace?.setActivityAssetSession?.({ token: null, enabled: false }).catch(() => {});
}
