import { create } from 'zustand';
import { api } from '../api/client';
import { androidCall, isAndroid } from '../platform/android';

interface ChannelNotificationState {
  mutedChannels: Set<string>;
  loaded: boolean;
  load: () => Promise<void>;
  isMuted: (channelId: string) => boolean;
  setMuted: (channelId: string, muted: boolean) => Promise<void>;
  reset: () => void;
}

export const useChannelNotificationStore = create<ChannelNotificationState>((set, get) => ({
  mutedChannels: new Set(),
  loaded: false,
  load: async () => {
    try {
      const result = await api.notifications.mutedChannels();
      set({ mutedChannels: new Set(result.mutedChannelIds), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  isMuted: (channelId) => get().mutedChannels.has(channelId),
  setMuted: async (channelId, muted) => {
    const previous = new Set(get().mutedChannels);
    const next = new Set(previous);
    if (muted) next.add(channelId); else next.delete(channelId);
    set({ mutedChannels: next });
    try {
      await api.channels.setNotificationSetting(channelId, muted);
      if (isAndroid()) void androidCall('channelNotification', { channelId, muted }).catch(() => {});
    } catch (error) {
      set({ mutedChannels: previous });
      throw error;
    }
  },
  reset: () => set({ mutedChannels: new Set(), loaded: false }),
}));

