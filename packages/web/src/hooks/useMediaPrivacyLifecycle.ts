import { useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
import { androidCall, isAndroid, onAndroid } from '../platform/android';
import { useSpaceStore } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';
import {
  refreshMediaPrivacy, setMediaPrivacyForeground, setMediaPrivacyVisit, useMediaPrivacyStore,
} from '../stores/mediaPrivacyStore';

export function useMediaPrivacyVisibility(): void {
  useLayoutEffect(() => {
    let frame = 0;
    let androidVisible = true;
    let disposed = false;
    let nativeEvents = 0;
    const updateVisibility = (visible: boolean) => {
      flushSync(() => setMediaPrivacyForeground(visible));
    };
    const handleVisibility = () => updateVisibility(androidVisible && !document.hidden);
    const hide = () => updateVisibility(false);
    const retry = () => { void refreshMediaPrivacy(); };
    const onNativeVisibility = ({ visible, generation }: { visible: boolean; generation?: number }) => {
      nativeEvents++;
      androidVisible = visible;
      // Native visibility is authoritative during the Activity transition.
      updateVisibility(visible);
      cancelAnimationFrame(frame);
      if (visible && generation !== undefined) {
        frame = requestAnimationFrame(() => {
          void androidCall('mediaPrivacyFrameReady', { generation }).catch(() => {});
        });
      }
    };
    const removeNative = isAndroid() ? onAndroid('webVisibility', onNativeVisibility) : undefined;
    if (isAndroid()) {
      void androidCall<{ visible: boolean; generation: number }>('mediaPrivacyFrameState')
        .then((state) => { if (!disposed && nativeEvents === 0) onNativeVisibility(state); })
        .catch(() => {});
    }
    const unsubscribe = useMediaPrivacyStore.subscribe((state, previous) => {
      const ui = useUIStore.getState();
      if (ui.activeModal !== 'imagePreview' || !ui.imagePreviewChannelId) return;
      if (state.visit !== previous.visit || state.enabled === null
        || (previous.showAll && !state.showAll)) ui.closeImagePreview();
    });
    setMediaPrivacyForeground(!document.hidden);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', handleVisibility);
    window.addEventListener('online', retry);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      removeNative?.();
      unsubscribe();
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', handleVisibility);
      window.removeEventListener('online', retry);
    };
  }, []);
}

export function useMediaPrivacyLifecycle(userId?: string, spaceId?: string, channelId?: string): void {
  const hasChatScreen = useUIStore((state) => !state.isMobile || state.mobileStack.some(
    (entry) => entry.screen === 'channel-chat'
      && entry.params?.spaceId === spaceId && entry.params?.channelId === channelId,
  ));
  const origin = useSpaceStore((state) => {
    const space = state.spaces.find((space) => space.id === spaceId);
    return space ? space._instanceOrigin ?? '' : undefined;
  });
  const type = useSpaceStore((state) => state.channels.find(
    (channel) => channel.id === channelId && channel.spaceId === spaceId,
  )?.type);

  useLayoutEffect(() => {
    if (hasChatScreen && userId && spaceId && spaceId !== '@me' && channelId && type !== 'voice' && origin !== undefined) {
      setMediaPrivacyVisit({ userId, origin, spaceId, channelId });
    } else {
      setMediaPrivacyVisit(null);
    }
  }, [hasChatScreen, userId, spaceId, channelId, origin, type]);

  useLayoutEffect(() => () => setMediaPrivacyVisit(null), []);
}
