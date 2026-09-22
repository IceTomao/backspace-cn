import { create } from 'zustand';
import type { Activity } from '@backspace/shared';
import { wsSendAll } from '../hooks/useWebSocket';

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let lastPushAt = 0;
let pendingActivities: Activity[] | null = null;
const ACTIVITY_PUSH_INTERVAL_MS = 3_100;

interface ActivityState {
  userActivities: Map<string, Activity[]>;
  showActivity: boolean;
  myActivities: Activity[] | null;

  setUserActivities: (userId: string, activities: Activity[]) => void;
  clearUserActivities: (userId: string) => void;
  initActivities: (activityMap: Record<string, Activity[]>) => void;
  setShowActivity: (show: boolean) => void;
  pushActivities: (activities: Activity[]) => void;
  reset: () => void;
}

export const useActivityStore = create<ActivityState>((set, get) => ({
  userActivities: new Map(),
  showActivity: true,
  myActivities: null,

  setUserActivities: (userId, activities) => {
    set((state) => {
      const next = new Map(state.userActivities);
      if (activities.length === 0) {
        next.delete(userId);
      } else {
        next.set(userId, activities);
      }
      return { userActivities: next };
    });
  },

  clearUserActivities: (userId) => {
    set((state) => {
      const next = new Map(state.userActivities);
      next.delete(userId);
      return { userActivities: next };
    });
  },

  initActivities: (activityMap) => {
    set((state) => {
      const next = new Map(state.userActivities);
      for (const [userId, activities] of Object.entries(activityMap)) {
        if (activities.length > 0) {
          next.set(userId, activities);
        } else {
          next.delete(userId);
        }
      }
      return { userActivities: next };
    });
  },

  setShowActivity: (show) => {
    set({ showActivity: show });
    if (!show) {
      if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
      pendingActivities = null;
      wsSendAll({ type: 'activity_update', activities: [] });
      set({ myActivities: null });
    }
  },

  pushActivities: (activities) => {
    if (!get().showActivity) return;
    set({ myActivities: activities });
    pendingActivities = activities;
    const push = () => {
      if (!pendingActivities) return;
      wsSendAll({ type: 'activity_update', activities: pendingActivities });
      pendingActivities = null;
      lastPushAt = Date.now();
      pushTimer = null;
    };
    if (pushTimer) return;
    const wait = Math.max(0, lastPushAt + ACTIVITY_PUSH_INTERVAL_MS - Date.now());
    if (wait === 0) push();
    else pushTimer = setTimeout(push, wait);
  },

  reset: () => {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    pendingActivities = null;
    lastPushAt = 0;
    set({ userActivities: new Map(), showActivity: true, myActivities: null });
  },
}));
