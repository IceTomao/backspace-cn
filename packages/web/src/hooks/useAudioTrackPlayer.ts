import { useRef, useEffect } from 'react';
import { AudioManager } from '../audio/AudioManager';
import {
  createParticipantEqChain,
  DEFAULT_PARTICIPANT_EQ,
  type ParticipantEq,
  type ParticipantEqChain,
} from '../audio/participantEq';

interface UseAudioTrackPlayerOptions {
  track: MediaStreamTrack | null;
  volume: number;  // final computed value, 0.0 – 4.0+
  muted: boolean;  // deafen, stream mute, etc.
  /** Per-participant equalizer for this track; omitted means a flat chain. */
  eq?: ParticipantEq | null;
}

/**
 * Hybrid audio pipeline for a single remote audio track.
 *
 * Architecture:
 *   1. A MUTED <audio> element keeps Chrome's WebRTC audio pipeline alive
 *      for the track. Chrome requires an HTML media element consuming a
 *      WebRTC MediaStreamTrack or it stops processing it. The element is
 *      always muted (volume=0, muted=true) — it never produces audible output.
 *
 *   2. A Web Audio pipeline handles ALL actual audio output:
 *      MediaStreamTrack -> MediaStream -> MediaStreamAudioSourceNode
 *        -> equalizer chain -> GainNode -> ctx.destination
 *
 * This gives us:
 *   - Chrome compatibility (muted <audio> keep-alive)
 *   - No ducking (all elements are muted, only Web Audio produces sound)
 *   - Clean mixing (single ctx.destination for all tracks)
 *   - Full volume range (0.0 – 4.0+) via GainNode
 *   - Smooth transitions via setTargetAtTime (no clicks/pops)
 *   - Per-participant tone shaping before the volume gain
 */
export function useAudioTrackPlayer(
  opts: UseAudioTrackPlayerOptions,
): React.RefObject<HTMLAudioElement> {
  const { track, volume, muted, eq } = opts;

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const eqChainRef = useRef<ParticipantEqChain | null>(null);
  const gainRef = useRef<GainNode | null>(null);

  // Keep current volume/muted/eq in refs so Effect 1 can read them
  // for the initial ramp without depending on them
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  const eqRef = useRef(eq);
  volumeRef.current = volume;
  mutedRef.current = muted;
  eqRef.current = eq;

  // Effect 1: Track attachment (keep-alive) + Web Audio pipeline build
  useEffect(() => {
    const audioEl = audioRef.current;

    // Tear down previous Web Audio graph
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (eqChainRef.current) {
      eqChainRef.current.dispose();
      eqChainRef.current = null;
    }
    if (gainRef.current) {
      gainRef.current.disconnect();
      gainRef.current = null;
    }

    if (!track) {
      if (audioEl) audioEl.srcObject = null;
      return;
    }

    // --- Keep-alive: attach track to <audio> element (always muted) ---
    // Chrome needs an HTML element consuming the WebRTC track or it
    // stops the audio pipeline for that track entirely.
    if (audioEl) {
      audioEl.srcObject = new MediaStream([track]);
      audioEl.muted = true;
      audioEl.volume = 0;
      audioEl.play().catch(() => {});
    }

    // --- Web Audio pipeline for actual output ---
    const ctx = AudioManager.getInstance().ensureContext();

    const stream = new MediaStream([track]);
    const source = ctx.createMediaStreamSource(stream);
    const eqChain = createParticipantEqChain(ctx, (eqRef.current ?? DEFAULT_PARTICIPANT_EQ).gains);
    const gain = ctx.createGain();

    // Start gain at 0 to prevent pop, then ramp to target
    gain.gain.setValueAtTime(0, ctx.currentTime);
    const targetGain = mutedRef.current ? 0 : volumeRef.current;
    gain.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.015);

    source.connect(eqChain.input);
    eqChain.output.connect(gain);
    gain.connect(AudioManager.getInstance().getMasterOutput());

    sourceRef.current = source;
    eqChainRef.current = eqChain;
    gainRef.current = gain;

    return () => {
      source.disconnect();
      eqChain.dispose();
      gain.disconnect();
      sourceRef.current = null;
      eqChainRef.current = null;
      gainRef.current = null;
    };
  }, [track]);

  // Effect 2: Update gain when volume or muted changes (no graph rebuild)
  useEffect(() => {
    if (!gainRef.current) return;

    const ctx = AudioManager.getInstance().ensureContext();
    const targetGain = muted ? 0 : volume;
    gainRef.current.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.015);
  }, [volume, muted]);

  // Effect 3: Ramp the equalizer when the participant's settings change
  useEffect(() => {
    if (!eqChainRef.current) return;
    eqChainRef.current.setGains((eq ?? DEFAULT_PARTICIPANT_EQ).gains);
  }, [eq]);

  return audioRef;
}
