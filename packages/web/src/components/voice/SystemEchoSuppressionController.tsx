import { useEffect } from 'react';

import { AudioManager } from '../../audio/AudioManager';
import { acquireSystemAudioReference } from '../../audio/systemAudioReference';
import { useVoiceStore } from '../../stores/voiceStore';

/**
 * Keeps the audio manager's echo suppressor in step with the call lifecycle.
 *
 * Mounted once next to `GlobalAudioRenderer`, so it is alive for the whole app
 * session and reacts to joins/leaves without duplicating work in the two voice
 * layouts:
 *
 * - preference on → the worklet is loaded and the app-playback reference is
 *   tapped immediately (that fallback needs no permissions and is always
 *   available);
 * - inside a call and running under the desktop shell → a device-output loopback
 *   capture is attached on top, which is the reference the user asked for ("read
 *   everything the device plays");
 * - leaving the call or switching the preference off → the capture is released by
 *   `AudioManager.releaseInputStream` / `setEchoSuppressionEnabled`.
 *
 * The loopback capture is best-effort by design: denial, a missing source or a
 * timeout leaves the app-playback reference in place instead of failing the call.
 */
export function SystemEchoSuppressionController(): null {
  const enabled = useVoiceStore((state) => state.systemEchoSuppression);
  const connected = useVoiceStore((state) => state.isLiveKitConnected);

  useEffect(() => {
    const manager = AudioManager.getInstance();
    void manager.setEchoSuppressionEnabled(enabled);
    if (!enabled || !connected) return;

    let cancelled = false;
    void (async () => {
      const reference = await acquireSystemAudioReference();
      if (cancelled) {
        for (const track of reference?.getTracks() ?? []) track.stop();
        return;
      }
      await manager.attachEchoReferenceStream(reference);
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, connected]);

  return null;
}
