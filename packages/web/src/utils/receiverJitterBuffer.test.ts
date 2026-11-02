import { describe, expect, it } from 'vitest';
import { Track, type Room } from 'livekit-client';
import { applyStreamReceiverJitterBuffer, DEFAULT_STREAM_JITTER_BUFFER_MS } from './receiverJitterBuffer';

describe('applyStreamReceiverJitterBuffer', () => {
  it('applies 120ms playout buffer strictly to subscribed ScreenShare & ScreenShareAudio receivers, never Microphone or Camera', () => {
    const micReceiver = { track: { id: 'mic-track' }, jitterBufferTarget: null as number | null, playoutDelayHint: undefined as number | undefined };
    const camReceiver = { track: { id: 'cam-track' }, jitterBufferTarget: null as number | null, playoutDelayHint: undefined as number | undefined };
    const screenVideoReceiver = { track: { id: 'screen-video-track' }, jitterBufferTarget: null as number | null, playoutDelayHint: undefined as number | undefined };
    const screenAudioReceiver = { track: { id: 'screen-audio-track' }, jitterBufferTarget: null as number | null, playoutDelayHint: undefined as number | undefined };

    const room = {
      engine: {
        pcManager: {
          subscriber: {
            pc: {
              getReceivers: () => [micReceiver, camReceiver, screenVideoReceiver, screenAudioReceiver],
            },
          },
        },
      },
      remoteParticipants: new Map([
        [
          'u1:alice',
          {
            trackPublications: new Map([
              ['mic', { source: Track.Source.Microphone, isSubscribed: true, track: { mediaStreamTrack: { id: 'mic-track' } } }],
              ['cam', { source: Track.Source.Camera, isSubscribed: true, track: { mediaStreamTrack: { id: 'cam-track' } } }],
              ['ss-v', { source: Track.Source.ScreenShare, isSubscribed: true, track: { mediaStreamTrack: { id: 'screen-video-track' } } }],
              ['ss-a', { source: Track.Source.ScreenShareAudio, isSubscribed: true, track: { mediaStreamTrack: { id: 'screen-audio-track' } } }],
            ]),
          },
        ],
      ]),
    } as unknown as Room;

    const updated = applyStreamReceiverJitterBuffer(room, false);
    expect(updated).toBe(2);
    expect(screenVideoReceiver.jitterBufferTarget).toBe(DEFAULT_STREAM_JITTER_BUFFER_MS);
    expect(screenVideoReceiver.playoutDelayHint).toBe(DEFAULT_STREAM_JITTER_BUFFER_MS / 1000);
    expect(screenAudioReceiver.jitterBufferTarget).toBe(DEFAULT_STREAM_JITTER_BUFFER_MS);
    expect(screenAudioReceiver.playoutDelayHint).toBe(DEFAULT_STREAM_JITTER_BUFFER_MS / 1000);

    // Voice & camera tracks must remain untouched at default real-time latency
    expect(micReceiver.jitterBufferTarget).toBeNull();
    expect(micReceiver.playoutDelayHint).toBeUndefined();
    expect(camReceiver.jitterBufferTarget).toBeNull();
    expect(camReceiver.playoutDelayHint).toBeUndefined();

    // Toggling Ultra-Low Latency mode drops only stream receivers to 0ms
    const resetCount = applyStreamReceiverJitterBuffer(room, true);
    expect(resetCount).toBe(2);
    expect(screenVideoReceiver.jitterBufferTarget).toBe(0);
    expect(screenVideoReceiver.playoutDelayHint).toBe(0);
    expect(screenAudioReceiver.jitterBufferTarget).toBe(0);
    expect(micReceiver.jitterBufferTarget).toBeNull();
  });
});
