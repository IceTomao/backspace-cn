import { Track, type Room } from 'livekit-client';
import { getMediaStreamTrack, getSubscriberPC } from './livekitInternals';

/**
 * Default light playout buffer (120 ms) applied ONLY to remote ScreenShare and
 * ScreenShareAudio receivers. Absorbs 20–80 ms cross-ISP UDP micro-bursts so
 * 60 fps streams pace evenly instead of freezing and fast-forwarding.
 *
 * Microphone and Camera tracks are NEVER touched so voice conversation stays
 * at WebRTC's minimum real-time latency.
 */
export const DEFAULT_STREAM_JITTER_BUFFER_MS = 120;

interface PlayoutConfigurableReceiver extends RTCRtpReceiver {
  playoutDelayHint?: number;
}

export function applyStreamReceiverJitterBuffer(room: Room | null, lowLatency: boolean): number {
  if (!room) return 0;
  const pc = getSubscriberPC(room);
  if (!pc || typeof pc.getReceivers !== 'function') return 0;

  const streamTrackIds = new Set<string>();
  room.remoteParticipants.forEach((participant) => {
    participant.trackPublications.forEach((pub) => {
      if (pub.source !== Track.Source.ScreenShare && pub.source !== Track.Source.ScreenShareAudio) {
        return;
      }
      if (!pub.isSubscribed || !pub.track) return;
      const mediaTrack = getMediaStreamTrack(pub.track);
      if (mediaTrack?.id) {
        streamTrackIds.add(mediaTrack.id);
      }
    });
  });

  if (streamTrackIds.size === 0) return 0;

  const targetMs = lowLatency ? 0 : DEFAULT_STREAM_JITTER_BUFFER_MS;
  const delaySeconds = targetMs / 1000;
  let updatedCount = 0;

  for (const rawReceiver of pc.getReceivers()) {
    const receiver = rawReceiver as PlayoutConfigurableReceiver;
    const trackId = receiver.track?.id;
    if (!trackId || !streamTrackIds.has(trackId)) continue;

    let applied = false;
    try {
      if ('jitterBufferTarget' in receiver) {
        receiver.jitterBufferTarget = targetMs;
        applied = true;
      }
    } catch {
      // Some engines reject values outside implementation bounds; fall through to playoutDelayHint.
    }

    try {
      if ('playoutDelayHint' in receiver) {
        receiver.playoutDelayHint = delaySeconds;
        applied = true;
      }
    } catch {
      // Ignore unsupported vendor hint errors.
    }

    if (applied) updatedCount += 1;
  }

  return updatedCount;
}
