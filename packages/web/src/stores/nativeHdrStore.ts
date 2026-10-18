import { create } from 'zustand';
import { api } from '../api/client';
import { useAuthStore } from './authStore';
import { useVoiceStore } from './voiceStore';
import { getChannelOrigin, getMyUserIdForOrigin, useSpaceStore } from './spaceStore';
import { broadcastVoiceStatus } from '../utils/voice';
import { isHdrColor, type HdrColor } from '../utils/hdrColor';

export interface HdrDisplay { id: string; name: string; hdrActive: boolean; width: number; height: number }
export type HdrUnavailableReason = 'validation_pending' | 'native_unavailable' | 'system_hdr_off' | 'source_unsupported' | 'native_failed' | 'server_unsupported' | 'encoder_unavailable';
interface NativeHdrState {
  available: boolean;
  publisherAvailable: boolean;
  labMode: boolean;
  experimental: boolean;
  colorControl: boolean;
  pendingColor: HdrColor | null;
  colorError: boolean;
  reason: HdrUnavailableReason;
  displays: HdrDisplay[];
  publication: { identity: string; trackSid: string } | null;
  watchingUserId: string | null;
  refresh: (probeEncoder?: boolean) => Promise<void>;
  setColor: (color: HdrColor) => void;
  publish: (sourceId: string, config: { width: number; height: number; fps: number; bitrateKbps: number; shareAudio: boolean; color?: HdrColor }) => Promise<boolean>;
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
let colorTimer: ReturnType<typeof setTimeout> | undefined;
let colorBusy = false, colorGeneration = 0;
function cancelColor() {
  colorGeneration++; clearTimeout(colorTimer); colorTimer = undefined; colorBusy = false;
  useNativeHdrStore.setState({ pendingColor: null, colorError: false });
}
function queueColor() {
  if (colorTimer || colorBusy) return;
  colorTimer = setTimeout(() => { colorTimer = undefined; void flushColor(); }, 100);
}
async function flushColor() {
  const state = useNativeHdrStore.getState(), color = state.pendingColor;
  const requestId = requestIds.publisher, generation = colorGeneration;
  if (!color || !requestId || !state.publication || colorBusy) return;
  colorBusy = true;
  try {
    const result = await window.backspace?.hdrNative?.({ action: 'publisher-color', requestId, color }) as { ok?: boolean } | undefined;
    if (generation !== colorGeneration || requestIds.publisher !== requestId) return;
    if (result?.ok !== true) throw new Error('HDR color not applied');
    useVoiceStore.getState().setScreenShareConfig({ hdrExposureEv: color.exposureEv, hdrBrightness: color.brightness });
    if (useNativeHdrStore.getState().pendingColor === color) useNativeHdrStore.setState({ pendingColor: null });
  } catch {
    if (generation === colorGeneration) useNativeHdrStore.setState({ pendingColor: null, colorError: true });
  } finally {
    if (generation === colorGeneration) {
      colorBusy = false;
      if (useNativeHdrStore.getState().pendingColor) queueColor();
    }
  }
}
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
      cancelColor();
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
  available: false, publisherAvailable: false, labMode: false, experimental: false, colorControl: false, pendingColor: null, colorError: false,
  reason: 'native_unavailable', displays: [], publication: null, watchingUserId: null,
  refresh: async (probeEncoder = false) => {
    bindEvents();
    const native = window.backspace?.hdrNative;
    if (!native || window.backspace?.platform !== 'win32') { set({ available: false, publisherAvailable: false, experimental: false, colorControl: false, reason: 'native_unavailable', displays: [] }); return; }
    try {
      const [server, local] = await Promise.all([api.livekit.status(), native({ action: 'capabilities', ...(probeEncoder ? { probeEncoder: true } : {}) })]) as [
        { nativeHdrProtocol?: number }, { protocol?: number; available?: boolean; publisherAvailable?: boolean; labMode?: boolean; experimental?: boolean; colorControl?: number; reason?: HdrUnavailableReason; displays?: HdrDisplay[] }];
      if (server.nativeHdrProtocol !== 1) { set({ available: false, publisherAvailable: false, experimental: false, colorControl: false, reason: 'server_unsupported', displays: [] }); return; }
      if (local.protocol !== 1 || !Array.isArray(local.displays)) throw new Error('Invalid HDR capability response');
      set({ available: local.available === true, publisherAvailable: local.publisherAvailable === true, labMode: local.labMode === true,
        experimental: local.experimental === true, colorControl: local.colorControl === 1, reason: local.reason ?? 'native_unavailable', displays: local.displays });
    } catch { set({ available: false, publisherAvailable: false, experimental: false, colorControl: false, reason: 'native_failed', displays: [] }); }
  },
  setColor: color => {
    if (!isHdrColor(color)) return;
    const voice = useVoiceStore.getState();
    if (!voice.screenShareConfig.hdrEnabled) return;
    if (!voice.isScreenSharing) {
      voice.setScreenShareConfig({ hdrExposureEv: color.exposureEv, hdrBrightness: color.brightness });
      set({ colorError: false }); return;
    }
    if (voice.screenShareDynamicRange !== 'hdr' || !get().publication || !get().colorControl) return;
    set({ pendingColor: color, colorError: false }); queueColor();
  },
  publish: async (sourceId, config) => {
    bindEvents();
    if (!get().publisherAvailable) return false;
    cancelColor();
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
      const latest = useVoiceStore.getState().screenShareConfig;
      if (latest.hdrExposureEv !== (config.color?.exposureEv ?? 0) || latest.hdrBrightness !== (config.color?.brightness ?? 0))
        get().setColor({ exposureEv: latest.hdrExposureEv, brightness: latest.hdrBrightness });
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
      cancelColor();
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
