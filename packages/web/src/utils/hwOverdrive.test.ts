import { afterEach, describe, expect, it, vi } from 'vitest';
import { activate, deactivate, rewriteScreenShareSdp } from './hwOverdrive';

describe('hwOverdrive SDP rewriter', () => {
  afterEach(() => {
    deactivate();
    vi.unstubAllGlobals();
  });

  it('upgrades H.264 baseline profile to High Profile 5.0 and injects start/min bitrate floor', () => {
    const sdp = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96 102',
      'a=msid:stream-1 screen-track-1',
      'a=rtpmap:96 VP8/90000',
      'a=rtpmap:102 H264/90000',
      'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
      '',
    ].join('\r\n');

    const rewritten = rewriteScreenShareSdp(sdp, {
      codec: 'h264',
      targetBitrateBps: 8_000_000,
      trackId: 'screen-track-1',
    });

    expect(rewritten).toContain('profile-level-id=4d0032');
    expect(rewritten).toContain('x-google-start-bitrate=6000');
    expect(rewritten).toContain('x-google-min-bitrate=2800');
  });

  it('synthesizes fmtp bitrate floor for VP9/H.265 when fmtp line is absent and leaves camera m=video untouched', () => {
    const sdp = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 102',
      'a=msid:cam-stream cam-track-1',
      'a=rtpmap:102 H264/90000',
      'a=fmtp:102 profile-level-id=42e01f',
      'm=video 9 UDP/TLS/RTP/SAVPF 98 104',
      'a=msid:screen-stream screen-track-2',
      'a=rtpmap:98 VP9/90000',
      'a=rtpmap:104 H265/90000',
      '',
    ].join('\r\n');

    const rewritten = rewriteScreenShareSdp(sdp, {
      codec: 'h265',
      targetBitrateBps: 14_000_000,
      trackId: 'screen-track-2',
    });

    // Camera section keeps baseline profile and receives no screen-share bitrate floor
    expect(rewritten).toContain('a=fmtp:102 profile-level-id=42e01f\r\n');
    // Screen-share H.265 payload 104 receives synthesized fmtp with start=10500 and clamped min=4500
    expect(rewritten).toContain('a=fmtp:104 x-google-start-bitrate=10500;x-google-min-bitrate=4500');
  });

  it('patches RTCPeerConnection.prototype.createOffer while active and restores it on deactivate', async () => {
    const baseCreateOffer = vi.fn(async (): Promise<RTCSessionDescriptionInit> => ({
      type: 'offer',
      sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 98\r\na=rtpmap:98 VP9/90000\r\na=fmtp:98 profile-id=0\r\n',
    }));
    class FakePeerConnection {
      createOffer(_opts?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
        return baseCreateOffer();
      }
    }
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);

    activate({ codec: 'vp9', targetBitrateBps: 6_000_000 });
    const pc = new FakePeerConnection();
    const offer = await pc.createOffer();

    expect(offer).toEqual({
      type: 'offer',
      sdp: expect.stringContaining('a=fmtp:98 profile-id=0;x-google-start-bitrate=4500;x-google-min-bitrate=2100'),
    });

    deactivate();
    const rawOffer = await pc.createOffer();
    expect(rawOffer.sdp).not.toContain('x-google-start-bitrate');
  });

  it('upgrades H.264 REGRESSION backup transceiver when primary codec is H.265 while excluding camera', () => {
    const sdp = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 102',
      'a=msid:cam-stream cam-track-1',
      'a=rtpmap:102 H264/90000',
      'a=fmtp:102 profile-level-id=42e01f',
      'm=video 9 UDP/TLS/RTP/SAVPF 104 102',
      'a=msid:screen-stream screen-primary-track',
      'a=rtpmap:104 H265/90000',
      'a=rtpmap:102 H264/90000',
      'a=fmtp:102 profile-level-id=42e01f',
      'm=video 9 UDP/TLS/RTP/SAVPF 102',
      'a=msid:backup-stream screen-cloned-backup-track',
      'a=rtpmap:102 H264/90000',
      'a=fmtp:102 profile-level-id=42e01f',
      '',
    ].join('\r\n');

    const rewritten = rewriteScreenShareSdp(sdp, {
      codec: 'h265',
      targetBitrateBps: 14_000_000,
      trackId: 'screen-primary-track',
      excludeTrackIds: ['cam-track-1'],
    });

    const sections = rewritten.split('m=video ');
    // Camera section stays untouched
    expect(sections[1]).toContain('profile-level-id=42e01f');
    expect(sections[1]).not.toContain('x-google-start-bitrate');
    // Primary H.265 section upgrades H.264 and sets bitrate floor on both H.265 & H.264
    expect(sections[2]).toContain('a=fmtp:104 x-google-start-bitrate=10500;x-google-min-bitrate=4500');
    expect(sections[2]).toContain('a=fmtp:102 profile-level-id=4d0032;x-google-start-bitrate=10500;x-google-min-bitrate=4500');
    // Cloned H.264 backup transceiver also upgrades to 4d0032 + bitrate floor
    expect(sections[3]).toContain('a=fmtp:102 profile-level-id=4d0032;x-google-start-bitrate=10500;x-google-min-bitrate=4500');
  });
});
