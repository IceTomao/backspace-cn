/**
 * Which pieces of chrome stay visible while a voice call is in fullscreen.
 *
 * Fullscreen exists so the call itself fills the screen: everything else is
 * decoration that some people want and others find distracting. Each flag
 * removes one overlay independently instead of offering a single "clean mode",
 * because the useful combination differs (a streamer hiding the badges still
 * wants the participant bar, someone watching a movie wants nothing at all).
 *
 * The flags only apply in fullscreen — the docked layout is a normal panel and
 * its chrome is the only way to tell what the panel is.
 */
export interface VoiceFullscreenChrome {
  /** The channel header strip at the top of the call (also hides its buttons). */
  hideHeader: boolean;
  /** The red "LIVE" badge in the corner of a screen-share tile. */
  hideLiveBadge: boolean;
  /** The stream health / resolution badge in the corner of a screen-share tile. */
  hideQualityBadge: boolean;
  /** The name strip along the bottom of a screen-share tile. */
  hideCaption: boolean;
  /** The call controls, revealed only when the pointer reaches the bottom edge. */
  hideControlBar: boolean;
}

export const VOICE_FULLSCREEN_CHROME_KEYS = [
  'hideHeader',
  'hideLiveBadge',
  'hideQualityBadge',
  'hideCaption',
  'hideControlBar',
] as const;

export const DEFAULT_VOICE_FULLSCREEN_CHROME: VoiceFullscreenChrome = Object.freeze({
  hideHeader: false,
  hideLiveBadge: false,
  hideQualityBadge: false,
  hideCaption: false,
  hideControlBar: false,
});

/**
 * Persisted state outlives the code that wrote it, so a missing, malformed or
 * future-shaped entry must degrade to the defaults instead of leaking
 * `undefined` into a className check. Only real booleans are accepted: values
 * such as `"true"` would quietly flip a flag nobody toggled.
 */
export function sanitizeVoiceFullscreenChrome(raw: unknown): VoiceFullscreenChrome {
  const next: VoiceFullscreenChrome = { ...DEFAULT_VOICE_FULLSCREEN_CHROME };
  if (typeof raw !== 'object' || raw === null) return next;
  const source = raw as Record<string, unknown>;
  for (const key of VOICE_FULLSCREEN_CHROME_KEYS) {
    const value = source[key];
    if (typeof value === 'boolean') next[key] = value;
  }
  return next;
}
