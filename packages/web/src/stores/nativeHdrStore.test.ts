import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ status: vi.fn(), broadcast: vi.fn() }));
vi.mock('../api/client', () => ({ api: { livekit: { status: mocks.status } } }));
vi.mock('./authStore', () => ({ useAuthStore: { getState: () => ({ token: 'account-token' }) } }));
vi.mock('./spaceStore', () => ({ getChannelOrigin: () => '', getMyUserIdForOrigin: () => 'alice', useSpaceStore: { getState: () => ({ channelToSpaceMap: new Map() }) } }));
vi.mock('../utils/voice', () => ({ broadcastVoiceStatus: mocks.broadcast }));
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
import { useNativeHdrStore } from './nativeHdrStore';
import { useVoiceStore } from './voiceStore';

const config = { width: 1920, height: 1080, fps: 60, bitrateKbps: 16000, shareAudio: false };
beforeEach(() => {
  useVoiceStore.setState({ ...useVoiceStore.getInitialState(), currentVoiceChannelId: 'voice' });
  useNativeHdrStore.setState({ available: false, publisherAvailable: false, reason: 'native_unavailable', displays: [], publication: null, watchingUserId: null });
  mocks.broadcast.mockReset(); mocks.status.mockResolvedValue({ nativeHdrProtocol: 1 });
});
afterEach(() => { delete window.backspace; vi.restoreAllMocks(); });

it('keeps HDR unavailable on older servers and clients even if HEVC exists', async () => {
  window.backspace = { platform: 'win32', hdrNative: vi.fn().mockResolvedValue({ protocol: 1, available: true, displays: [] }) } as any;
  mocks.status.mockResolvedValue({ state: null });
  await useNativeHdrStore.getState().refresh();
  expect(useNativeHdrStore.getState()).toMatchObject({ available: false, reason: 'server_unsupported' });
  delete window.backspace;
  await useNativeHdrStore.getState().refresh();
  expect(useNativeHdrStore.getState().available).toBe(false);
});

it('uses the native window for a candidate HDR viewer and keeps audio muted when deafened', async () => {
  const native = vi.fn().mockImplementation(async request => request.action === 'capabilities' ?
    { protocol: 1, available: true, publisherAvailable: false, displays: [] } : { ok: true });
  window.backspace = { platform: 'win32', hdrNative: native } as any;
  useVoiceStore.setState({ isDeafened: true });
  expect(await useNativeHdrStore.getState().view('bob', '__backspace_hdr_v1__bob:publish:session')).toBe(true);
  expect(native).toHaveBeenLastCalledWith({ action: 'viewer-audio', volume: 100, muted: true });
  useVoiceStore.setState({ isDeafened: false, outputVolume: 50, streamVolumes: new Map([['bob', 80]]) });
  expect(native).toHaveBeenLastCalledWith({ action: 'viewer-audio', volume: 40, muted: false });
  useVoiceStore.setState({ currentVoiceChannelId: null });
  expect(native).toHaveBeenLastCalledWith({ action: 'stop', kind: 'viewer' });
  expect(useNativeHdrStore.getState().watchingUserId).toBeNull();
});

it('does not announce HDR on native failure; a confirmed publication sets and clears the actual range', async () => {
  const native = vi.fn().mockImplementation(async request => {
    if (request.action === 'publish') throw new Error('encoder failed');
    return { ok: true };
  });
  window.backspace = { platform: 'win32', hdrNative: native } as any;
  useNativeHdrStore.setState({ available: true, publisherAvailable: true });
  expect(await useNativeHdrStore.getState().publish('hdr:display', config)).toBe(false);
  expect(useVoiceStore.getState().isScreenSharing).toBe(false);
  expect(useVoiceStore.getState().screenShareDynamicRange).toBe('sdr');
  native.mockImplementation(async request => request.action === 'publish' ? { identity: '__backspace_hdr_v1__alice:publish:session', trackSid: 'video' } : { ok: true });
  expect(await useNativeHdrStore.getState().publish('hdr:display', config)).toBe(true);
  expect(useVoiceStore.getState()).toMatchObject({ isScreenSharing: true, screenShareDynamicRange: 'hdr' });
  await useNativeHdrStore.getState().stop('publisher');
  expect(useVoiceStore.getState()).toMatchObject({ isScreenSharing: false, screenShareDynamicRange: 'sdr' });
});

it('stops a startup that completes after the owner changes channels', async () => {
  window.backspace = { platform: 'win32', hdrNative: vi.fn().mockImplementation(async request => {
    if (request.action === 'publish') {
      useVoiceStore.setState({ currentVoiceChannelId: 'another-channel' });
      return { identity: '__backspace_hdr_v1__alice:publish:session', trackSid: 'video' };
    }
    return { ok: true };
  }) } as any;
  useNativeHdrStore.setState({ available: true, publisherAvailable: true });
  expect(await useNativeHdrStore.getState().publish('hdr:display', config)).toBe(false);
  expect(useNativeHdrStore.getState().publication).toBeNull();
  expect(useVoiceStore.getState().isScreenSharing).toBe(false);
});

it('does not reactivate a cancelled startup or let an old process stop a newer stream', async () => {
  let finish!: (result: unknown) => void;
  let onEvent!: (event: unknown) => void;
  const native = vi.fn().mockImplementation(request => request.action === 'publish' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true }));
  window.backspace = { platform: 'win32', hdrNative: native, onHdrNativeEvent: callback => { onEvent = callback; return () => {}; } } as any;
  useNativeHdrStore.setState({ available: true, publisherAvailable: true });
  const pending = useNativeHdrStore.getState().publish('hdr:display', config);
  const firstId = native.mock.calls[0]![0].requestId;
  await useNativeHdrStore.getState().stop('publisher');
  finish({ identity: '__backspace_hdr_v1__alice:publish:session', trackSid: 'old' });
  expect(await pending).toBe(false);
  expect(useVoiceStore.getState().isScreenSharing).toBe(false);
  native.mockImplementation(async () => ({ identity: '__backspace_hdr_v1__alice:publish:session', trackSid: 'new' }));
  expect(await useNativeHdrStore.getState().publish('hdr:display', config)).toBe(true);
  onEvent({ kind: 'publisher', state: 'stopped', requestId: firstId });
  expect(useNativeHdrStore.getState().publication?.trackSid).toBe('new');
  const currentId = native.mock.calls.at(-1)![0].requestId;
  onEvent({ kind: 'publisher', state: 'stopped', requestId: currentId });
  expect(useNativeHdrStore.getState().publication).toBeNull();
  expect(useVoiceStore.getState().screenShareDynamicRange).toBe('sdr');
});
