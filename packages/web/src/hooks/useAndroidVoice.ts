import { useCallback, useEffect, useState } from 'react';
import { ConnectionState, type Room } from 'livekit-client';
import { androidCall, onAndroid, type NativeVoiceState } from '../platform/android';
import { useVoiceStore } from '../stores/voiceStore';
import { getChannelOrigin, useSpaceStore } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';
import type { ParticipantInfo } from './useLiveKit';

export const EMPTY_VOICE: NativeVoiceState = {
  channelId: null, origin: '', isDm: false, status: 'disconnected', muted: false,
  deafened: false, error: null, participants: [], devices: [], deviceId: null,
};
export function useAndroidVoice() {
  const [snapshot, setSnapshot] = useState(EMPTY_VOICE);
  useEffect(() => {
    let stopped = false;
    let applying = false;
    const apply = (state: NativeVoiceState) => {
      if (stopped) return;
      applying = true;
      setSnapshot(state);
      const participants: ParticipantInfo[] = state.participants.map(p => ({
        identity: p.identity, userId: p.identity.split(':')[0] ?? p.identity,
        username: p.name || p.identity.split(':')[1] || p.identity, homeUserId: null,
        isMuted: p.local ? state.muted : p.muted, isDeafened: p.local && state.deafened,
        isLocal: p.local, isCameraOn: false, isScreenSharing: false,
        audioTrack: null, videoTrack: null, screenTrack: null, screenAudioTrack: null,
        lkVideoTrack: null, lkScreenTrack: null, cachedUser: null,
      }));
      useVoiceStore.setState({
        participants, isMuted: state.muted, isDeafened: state.deafened,
        isCameraOn: false, isScreenSharing: false,
        isLiveKitConnected: state.status === 'connected',
        voiceConnectionStatus: state.status, connectionError: state.error,
        currentVoiceChannelId: state.isDm ? null : state.channelId,
        activeDmCall: state.isDm && state.channelId && !state.ringing ? { dmChannelId: state.channelId } : null,
        outgoingCall: state.ringing && state.channelId ? { dmChannelId: state.channelId } : null,
        callOrigin: state.origin,
      });
      useVoiceStore.getState().setSpeakingParticipants(new Set(state.participants.filter(p => p.speaking).map(p => p.identity)));
      applying = false;
    };
    const remove = onAndroid<NativeVoiceState>('voice', apply);
    void androidCall<NativeVoiceState>('voice').then(apply);
    const unsubscribe = useVoiceStore.subscribe((next, prev) => {
      if (applying) return;
      if (next.isMuted !== prev.isMuted || next.isDeafened !== prev.isDeafened ||
          next.outputVolume !== prev.outputVolume || next.participantVolumes !== prev.participantVolumes ||
          next.participantMutes !== prev.participantMutes) {
        void androidCall('audio', {
          muted: next.isMuted, deafened: next.isDeafened, outputVolume: next.outputVolume,
          volumes: Object.fromEntries(next.participantVolumes), mutes: Object.fromEntries(next.participantMutes),
        }).catch(() => useUIStore.getState().addToast('无法调整通话音频', 'warning'));
      }
    });
    const resume = () => {
      if (!document.hidden) void androidCall('sync');
    };
    document.addEventListener('visibilitychange', resume);
    return () => { stopped = true; remove(); unsubscribe(); document.removeEventListener('visibilitychange', resume); };
  }, []);
  const connect = useCallback(async (channelId: string, isDm = false) => {
    const state = useVoiceStore.getState();
    try {
      await androidCall('joinVoice', {
        channelId, isDm, origin: isDm ? state.callOrigin || getChannelOrigin(channelId) : getChannelOrigin(channelId),
        spaceId: useSpaceStore.getState().channelToSpaceMap.get(channelId) ?? '',
        muted: state.isMuted, deafened: state.isDeafened,
        livekitToken: isDm ? state.federatedCallToken : null,
        livekitUrl: isDm ? state.federatedCallUrl : null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '加入语音失败';
      useVoiceStore.setState({ currentVoiceChannelId: null, activeDmCall: null, connectionError: message });
      useUIStore.getState().addToast(message, 'warning');
      throw error;
    }
  }, []);
  const disconnect = useCallback(async () => { await androidCall('hangup'); }, []);
  const toggleMic = useCallback(async () => { useVoiceStore.getState().toggleMic(); }, []);
  return {
    room: null as Room | null, connect, disconnect, toggleMic,
    isConnected: snapshot.status === 'connected', isConnecting: snapshot.status === 'connecting',
    connectionState: snapshot.status as ConnectionState, connectedChannelId: snapshot.channelId, connectionError: snapshot.error,
  };
}
