import type { StreamDynamicRange, VoiceUserState } from '@backspace/shared';

/** Reserved for a verified native publisher, never an SDR HEVC track. */
export const HDR_SCREEN_TRACK_NAME = 'backspace-screen-hdr-v1';
export const HDR_IDENTITY_PREFIX = '__backspace_hdr_v1__';

export function nativeHdrOwner(identity: string): string | null {
  if (!identity.startsWith(HDR_IDENTITY_PREFIX)) return null;
  return identity.slice(HDR_IDENTITY_PREFIX.length).match(/^([^:]{1,128}):publish:[0-9a-f-]{36}$/)?.[1] ?? null;
}

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
