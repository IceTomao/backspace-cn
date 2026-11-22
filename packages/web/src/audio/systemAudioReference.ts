import { getElectronAPI } from '../platform/platform';

/**
 * Capture of everything the device is playing, used as the reference signal for
 * the echo suppressor.
 *
 * There is no dedicated API for "give me a loopback of the system output" in a
 * browser context, and Chromium's `getDisplayMedia` is the only door Electron
 * leaves open to it: the desktop shell answers the display-media request with
 * `audio: 'loopback'`. So the acquisition goes through the existing screen-source
 * preselection IPC (the same one the share flow uses), immediately followed by
 * `getDisplayMedia`, and the video half of the resulting stream is dropped.
 *
 * Every failure mode returns `null`; the caller then keeps the app-playback
 * fallback reference instead of degrading the microphone.
 */

/** How long to wait for the display-media handshake before giving up. */
export const SYSTEM_AUDIO_REFERENCE_TIMEOUT_MS = 8_000;

export interface ReferenceSource {
  id: string;
}

/** Minimal slice of the desktop bridge this module depends on. */
export interface SystemAudioReferenceBridge {
  getScreenSources: () => Promise<ReferenceSource[]>;
  preselectScreenSource: (sourceId: string, shareAudio?: boolean) => Promise<void>;
}

/**
 * Picks the source handed to the display-media handler. A whole screen is
 * preferred over a window: window loopback only carries that window's audio on
 * some platforms, while the screen source is the device mix.
 */
export function chooseReferenceSource<T extends ReferenceSource>(sources: readonly T[]): T | null {
  if (sources.length === 0) return null;
  const screen = sources.find((source) => source.id.startsWith('screen:'));
  return screen ?? sources[0] ?? null;
}

/**
 * Constraints for the reference capture. Explicitly *not* `restrictOwnAudio`:
 * the app's own playback is part of what leaks into the microphone, so it has to
 * stay in the reference.
 */
export function buildReferenceCaptureOptions(): DisplayMediaStreamOptions {
  return {
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    } as MediaTrackConstraints,
    video: true,
  };
}

/** Drops the video half of the capture, leaving a live audio-only stream. */
export function stripVideoTracks(stream: MediaStream): MediaStream | null {
  for (const track of stream.getVideoTracks()) {
    track.onended = null;
    track.stop();
  }
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    // Nothing usable came back: release whatever is left (the video tracks are
    // already stopped, so only the remaining kinds are touched).
    for (const track of stream.getTracks()) {
      if (track.kind !== 'video') track.stop();
    }
    return null;
  }
  return new MediaStream(audioTracks);
}

function resolveBridge(): SystemAudioReferenceBridge | null {
  const api = getElectronAPI();
  if (!api?.getScreenSources || !api.preselectScreenSource) return null;
  return {
    getScreenSources: api.getScreenSources,
    preselectScreenSource: api.preselectScreenSource,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Acquires the device-output reference capture. Resolves to `null` on the web
 * build, when the desktop bridge is missing, or whenever the capture cannot be
 * produced (permission denied, no sources, timeout).
 */
export async function acquireSystemAudioReference(): Promise<MediaStream | null> {
  const bridge = resolveBridge();
  if (!bridge) return null;
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) return null;

  let capture: Promise<MediaStream> | null = null;
  try {
    const sources = await bridge.getScreenSources();
    const source = chooseReferenceSource(sources ?? []);
    if (!source) return null;
    // Arm the selection before requesting the stream: the desktop handler is
    // stateless and consumes whatever was armed, so ordering matters.
    await bridge.preselectScreenSource(source.id, true);
    capture = navigator.mediaDevices.getDisplayMedia(buildReferenceCaptureOptions());

    const stream = await withTimeout(capture, SYSTEM_AUDIO_REFERENCE_TIMEOUT_MS);
    if (!stream) {
      // The request is still in flight; stop whatever it eventually returns so
      // the capture does not linger in the background.
      void capture
        .then((late) => late.getTracks().forEach((track) => track.stop()))
        .catch(() => undefined);
      return null;
    }
    const audioOnly = stripVideoTracks(stream);
    if (!audioOnly) return null;
    for (const track of audioOnly.getAudioTracks()) {
      // A reference capture that ends mid-call must not look like the user
      // stopped sharing: the suppressor simply falls back to the app bus.
      track.onended = null;
    }
    return audioOnly;
  } catch (error) {
    console.warn('[SystemAudioReference] Could not capture device audio:', error);
    if (capture) {
      void capture
        .then((late) => late.getTracks().forEach((track) => track.stop()))
        .catch(() => undefined);
    }
    return null;
  }
}
