import type { StreamDynamicRange, VoiceUserState } from '@backspace/shared';

/** Reserved for a verified native publisher, never an SDR HEVC track. */
export const HDR_SCREEN_TRACK_NAME = 'backspace-screen-hdr-v1';

export function streamDynamicRange(status?: VoiceUserState, trackNames: Iterable<string> = []): StreamDynamicRange {
  if (status?.isScreenSharing && status.dynamicRange === 'hdr') return 'hdr';
  for (const name of trackNames) if (name === HDR_SCREEN_TRACK_NAME) return 'hdr';
  return 'sdr';
}

/**
 * HEVC decode support, CSS dynamic-range, and a monitor model do not prove HDR
 * rendering. No shipping playback path has passed dual-machine acceptance yet.
 * Keep the gate closed until the native decoder/renderer supplies that proof.
 */
export function canViewStream(dynamicRange: StreamDynamicRange): boolean {
  return dynamicRange === 'sdr';
}
