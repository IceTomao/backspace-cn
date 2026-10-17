import { create } from 'zustand';
import { api } from '../api/client';
import { useAuthStore } from './authStore';
import { useVoiceStore } from './voiceStore';
import { getChannelOrigin, getMyUserIdForOrigin, useSpaceStore } from './spaceStore';
import { broadcastVoiceStatus } from '../utils/voice';

export interface HdrDisplay { id: string; name: string; hdrActive: boolean; width: number; height: number }
export type HdrUnavailableReason = 'validation_pending' | 'native_unavailable' | 'system_hdr_off' | 'source_unsupported' | 'native_failed' | 'server_unsupported' | 'encoder_unavailable';
interface NativeHdrState {
  available: boolean;
  publisherAvailable: boolean;
  labMode: boolean;
  reason: HdrUnavailableReason;
  displays: HdrDisplay[];
  publication: { identity: string; trackSid: string } | null;
  watchingUserId: string | null;
  refresh: () => Promise<void>;
  publish: (sourceId: string, config: { width: number; height: number; fps: number; bitrateKbps: number; shareAudio: boolean }) => Promise<boolean>;
  stop: (kind: 'publisher' | 'viewer') => Promise<void>;
  view: (userId: string, publisher: string) => Promise<boolean>;
}

function voiceSession() {
  const voice = useVoiceStore.getState();
  const channelId = voice.currentVoiceChannelId ?? voice.activeDmCall?.dmChannelId;
  const origin = voice.callOrigin ?? (channelId ? getChannelOrigin(channelId) : '');
  if (!channelId || (origin && origin !== window.location.origin)) throw new Error('Native HDR requires a local voice session');
  const authToken = useAuthStore.getState().token;
  if (!authToken) throw new Error('HDR authorization unavailable');
  return { channelId, authToken, isDm: !voice.currentVoiceChannelId };
}
let boundApi: BackspaceElectronAPI | undefined;
let unbind: (() => void) | undefined;
const revisions = { publisher: 0, viewer: 0 };
const requestIds: Record<'publisher' | 'viewer', string | null> = { publisher: null, viewer: null };
let audioUnbind: (() => void) | undefined;
let authUnbind: (() => void) | undefined;
const sessions: Partial<Record<'publisher' | 'viewer', ReturnType<typeof voiceSession>>> = {};
let lastAudio = '';
function syncSession() {
  for (const kind of ['publisher', 'viewer'] as const) {
    const owner = sessions[kind];
    if (!owner) continue;
    try {
      const current = voiceSession();
      if (current.channelId === owner.channelId && current.isDm === owner.isDm && current.authToken === owner.authToken) continue;
    } catch { /* disconnected or signed out */ }
    void useNativeHdrStore.getState().stop(kind);
  }
  syncViewerAudio();
}
function syncViewerAudio() {
  const userId = useNativeHdrStore.getState().watchingUserId;
  if (!userId) { lastAudio = ''; return; }
  const voice = useVoiceStore.getState();
  const channel = voice.currentVoiceChannelId;
  const spaceId = channel ? useSpaceStore.getState().channelToSpaceMap.get(channel) : undefined;
  const myId = getMyUserIdForOrigin(channel ? getChannelOrigin(channel) : '');
  const muted = voice.isDeafened || voice.spaceDeafenedUserIds.has(`${spaceId}:${myId}`) || voice.streamMutes.get(userId) === true;
  const volume = Math.min(400, Math.max(0, voice.outputVolume * (voice.streamVolumes.get(userId) ?? 100) / 100));
  const signature = JSON.stringify({ userId, volume, muted });
  if (signature === lastAudio) return;
  lastAudio = signature;
  void window.backspace?.hdrNative?.({ action: 'viewer-audio', volume, muted }).catch(() => {});
}
function bindEvents() {
  const desktop = window.backspace;
  if (boundApi === desktop) return;
  unbind?.(); audioUnbind?.(); authUnbind?.(); boundApi = desktop; lastAudio = '';
  audioUnbind = useVoiceStore.subscribe(syncSession);
  authUnbind = useAuthStore.subscribe?.(syncSession);
  unbind = desktop?.onHdrNativeEvent?.(value => {
    const event = value as { kind?: unknown; state?: unknown; requestId?: unknown; reason?: string };
    if (event?.state !== 'stopped') return;
    if ((event.kind !== 'publisher' && event.kind !== 'viewer') || event.requestId !== requestIds[event.kind] || requestIds[event.kind] === null) return;
    requestIds[event.kind] = null;
    delete sessions[event.kind];
    if (event.kind === 'publisher') {
      revisions.publisher++;
      const wasLive = useNativeHdrStore.getState().publication !== null;
      useNativeHdrStore.setState({ publication: null });
      if (wasLive) { useVoiceStore.setState({ isScreenSharing: false, screenShareDynamicRange: 'sdr' }); broadcastVoiceStatus(); }
    } else if (event.kind === 'viewer') {
      revisions.viewer++;
      useNativeHdrStore.setState({ watchingUserId: null });
      if (event.reason) useNativeHdrStore.setState({ available: false, reason: event.reason === 'output_hdr_disabled' ? 'system_hdr_off' : 'native_failed' });
    }
  });
}

export const useNativeHdrStore = create<NativeHdrState>((set, get) => ({
  available: false, publisherAvailable: false, labMode: false, reason: 'native_unavailable', displays: [], publication: null, watchingUserId: null,
  refresh: async () => {
    bindEvents();
    const native = window.backspace?.hdrNative;
    if (!native || window.backspace?.platform !== 'win32') { set({ available: false, publisherAvailable: false, reason: 'native_unavailable', displays: [] }); return; }
    try {
      const [server, local] = await Promise.all([api.livekit.status(), native({ action: 'capabilities' })]) as [
        { nativeHdrProtocol?: number }, { protocol?: number; available?: boolean; publisherAvailable?: boolean; labMode?: boolean; reason?: HdrUnavailableReason; displays?: HdrDisplay[] }];
      if (server.nativeHdrProtocol !== 1) { set({ available: false, publisherAvailable: false, reason: 'server_unsupported', displays: [] }); return; }
      if (local.protocol !== 1 || !Array.isArray(local.displays)) throw new Error('Invalid HDR capability response');
      set({ available: local.available === true, publisherAvailable: local.publisherAvailable === true, labMode: local.labMode === true, reason: local.reason ?? 'native_unavailable', displays: local.displays });
    } catch { set({ available: false, publisherAvailable: false, reason: 'native_failed', displays: [] }); }
  },
  publish: async (sourceId, config) => {
    bindEvents();
    if (!get().publisherAvailable) return false;
    const revision = ++revisions.publisher;
    const requestId = requestIds.publisher = crypto.randomUUID();
    try {
      const session = voiceSession();
      sessions.publisher = session;
      const result = await window.backspace!.hdrNative!({ action: 'publish', requestId, sourceId, config, ...session }) as { identity?: string; trackSid?: string };
      if (revision !== revisions.publisher) return false;
      if (!result.identity?.startsWith('__backspace_hdr_v1__') || !result.trackSid) throw new Error('HDR publication not confirmed');
      const current = voiceSession();
      if (current.channelId !== session.channelId || current.isDm !== session.isDm || current.authToken !== session.authToken) { await get().stop('publisher'); return false; }
      set({ publication: { identity: result.identity, trackSid: result.trackSid } });
      useVoiceStore.setState({ isScreenSharing: true, screenShareDynamicRange: 'hdr' });
      broadcastVoiceStatus();
      return true;
    } catch { if (revision === revisions.publisher) await get().stop('publisher'); return false; }
  },
  stop: async kind => {
    revisions[kind]++;
    requestIds[kind] = null;
    delete sessions[kind];
    // Clear synchronously, before a new start or a late IPC response can arrive.
    if (kind === 'publisher') {
      const wasLive = get().publication !== null || useVoiceStore.getState().screenShareDynamicRange === 'hdr';
      set({ publication: null });
      if (wasLive) { useVoiceStore.setState({ isScreenSharing: false, screenShareDynamicRange: 'sdr' }); broadcastVoiceStatus(); }
    } else set({ watchingUserId: null });
    try { await window.backspace?.hdrNative?.({ action: 'stop', kind }); } catch { /* native owner also stops on navigation/disconnection */ }
  },
  view: async (userId, publisher) => {
    bindEvents();
    await get().refresh();
    if (!get().available) return false;
    const revision = ++revisions.viewer;
    const requestId = requestIds.viewer = crypto.randomUUID();
    try {
      const session = voiceSession();
      sessions.viewer = session;
      await window.backspace!.hdrNative!({ action: 'view', requestId, publisher, ...session });
      if (revision !== revisions.viewer) return false;
      const current = voiceSession();
      if (current.channelId !== session.channelId || current.isDm !== session.isDm || current.authToken !== session.authToken) { await get().stop('viewer'); return false; }
      set({ watchingUserId: userId }); syncViewerAudio(); return true;
    } catch { if (revision === revisions.viewer) await get().stop('viewer'); return false; }
  },
}));
