import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  encodeStreamWatch,
  parseStreamWatch,
  isStreamWatchPayload,
  canDecodeHevcWebRtc,
} from './streamWatchProtocol';

describe('streamWatchProtocol', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips an encoded payload with optional supportsHevc', () => {
    const payload = { type: 'stream_watch' as const, target: 'user-1', watching: true, supportsHevc: false };
    const encoded = encodeStreamWatch(payload);
    // Realm-safe Uint8Array check — TextEncoder returns a Uint8Array from Node's
    // realm, which `toBeInstanceOf(Uint8Array)` rejects under vitest+jsdom.
    expect(Object.prototype.toString.call(encoded)).toBe('[object Uint8Array]');
    const parsed = parseStreamWatch(encoded);
    expect(parsed).toEqual(payload);
  });

  it('parseStreamWatch returns null on invalid JSON', () => {
    const bad = new TextEncoder().encode('not json');
    expect(parseStreamWatch(bad)).toBeNull();
  });

  it('parseStreamWatch returns null on wrong message type', () => {
    const other = new TextEncoder().encode(JSON.stringify({ type: 'deafen', deafened: true }));
    expect(parseStreamWatch(other)).toBeNull();
  });

  it('isStreamWatchPayload validates shape including optional supportsHevc', () => {
    expect(isStreamWatchPayload({ type: 'stream_watch', target: 'u', watching: true })).toBe(true);
    expect(isStreamWatchPayload({ type: 'stream_watch', target: 'u', watching: true, supportsHevc: true })).toBe(true);
    expect(isStreamWatchPayload({ type: 'stream_watch', target: 'u', watching: true, supportsHevc: false })).toBe(true);
    expect(isStreamWatchPayload({ type: 'stream_watch', target: 'u', watching: true, supportsHevc: 'no' })).toBe(false);
    expect(isStreamWatchPayload({ type: 'stream_watch', target: 'u', watching: 'yes' })).toBe(false);
    expect(isStreamWatchPayload({ type: 'stream_watch', watching: true })).toBe(false);
    expect(isStreamWatchPayload({ type: 'other', target: 'u', watching: true })).toBe(false);
    expect(isStreamWatchPayload(null)).toBe(false);
    expect(isStreamWatchPayload('string')).toBe(false);
  });

  it('canDecodeHevcWebRtc detects receiver HEVC capability cleanly', () => {
    vi.stubGlobal('RTCRtpReceiver', undefined);
    expect(canDecodeHevcWebRtc()).toBeUndefined();

    vi.stubGlobal('RTCRtpReceiver', {
      getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP9' }, { mimeType: 'video/H264' }] }),
    });
    expect(canDecodeHevcWebRtc()).toBe(false);

    vi.stubGlobal('RTCRtpReceiver', {
      getCapabilities: () => ({ codecs: [{ mimeType: 'video/H265' }, { mimeType: 'video/H264' }] }),
    });
    expect(canDecodeHevcWebRtc()).toBe(true);
  });
});
