import { beforeEach, expect, it, vi } from 'vitest';
import { Track, type Room } from 'livekit-client';
import { setStreamSubscription } from './useLiveKit';
import { useVoiceStore } from '../stores/voiceStore';
import { canViewStream, HDR_SCREEN_TRACK_NAME, streamDynamicRange } from '../utils/hdrStream';

vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
vi.mock('./useWebSocket', () => ({ wsSend: vi.fn() }));

beforeEach(() => useVoiceStore.setState({ ...useVoiceStore.getInitialState() }));

function remote(identity: string, trackName = 'screen') {
  const publications = [Track.Source.Microphone, Track.Source.Camera, Track.Source.ScreenShare, Track.Source.ScreenShareAudio]
    .map(source => ({ source, trackName: source === Track.Source.ScreenShare ? trackName : '', setSubscribed: vi.fn() }));
  return { identity, publications, trackPublications: new Map(publications.map((pub, index) => [String(index), pub])) };
}

it.each(['snapshot', 'track-name'])('blocks HDR video and system audio via %s while preserving microphone and other broadcasters', method => {
  const hdr = remote('hdr:alice', method === 'track-name' ? HDR_SCREEN_TRACK_NAME : 'screen');
  const sdr = remote('sdr:bob');
  const room = { remoteParticipants: new Map([[hdr.identity, hdr], [sdr.identity, sdr]]) } as unknown as Room;
  if (method === 'snapshot') useVoiceStore.getState().setVoiceUserStatus('hdr', false, false, false, true, 'hdr');
  useVoiceStore.getState().watchStream('hdr');
  expect(setStreamSubscription(room, hdr.identity, true)).toBe(false);
  expect(useVoiceStore.getState().watchingStreams.has('hdr')).toBe(false);
  expect(hdr.publications[0]!.setSubscribed).not.toHaveBeenCalled();
  expect(hdr.publications[1]!.setSubscribed).not.toHaveBeenCalled();
  expect(hdr.publications[2]!.setSubscribed).toHaveBeenCalledWith(false);
  expect(hdr.publications[3]!.setSubscribed).toHaveBeenCalledWith(false);
  expect(setStreamSubscription(room, sdr.identity, true)).toBe(true);
  expect(sdr.publications[2]!.setSubscribed).toHaveBeenCalledWith(true);
  expect(sdr.publications[3]!.setSubscribed).toHaveBeenCalledWith(true);
});

it('never equates HEVC/browser HDR display capability with verified playback', () => {
  vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/H265' }] }) });
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  expect(canViewStream('hdr')).toBe(false);
  expect(canViewStream('sdr')).toBe(true);
  expect(streamDynamicRange()).toBe('sdr');
  vi.unstubAllGlobals();
});
