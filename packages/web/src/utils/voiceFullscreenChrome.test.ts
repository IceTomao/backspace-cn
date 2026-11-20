import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VOICE_FULLSCREEN_CHROME,
  VOICE_FULLSCREEN_CHROME_KEYS,
  sanitizeVoiceFullscreenChrome,
} from './voiceFullscreenChrome';

describe('voice fullscreen chrome preferences', () => {
  it('ships every overlay visible', () => {
    for (const key of VOICE_FULLSCREEN_CHROME_KEYS) {
      expect(DEFAULT_VOICE_FULLSCREEN_CHROME[key]).toBe(false);
    }
  });

  it('round-trips a complete record', () => {
    const stored = { ...DEFAULT_VOICE_FULLSCREEN_CHROME, hideLiveBadge: true, hideCaption: true };
    expect(sanitizeVoiceFullscreenChrome(stored)).toEqual({
      ...DEFAULT_VOICE_FULLSCREEN_CHROME,
      hideLiveBadge: true,
      hideCaption: true,
    });
  });

  it('fills in fields a partial record omits', () => {
    const sanitized = sanitizeVoiceFullscreenChrome({ hideHeader: true });
    expect(sanitized).toEqual({ ...DEFAULT_VOICE_FULLSCREEN_CHROME, hideHeader: true });
  });

  it('ignores values that are not booleans', () => {
    const sanitized = sanitizeVoiceFullscreenChrome({
      hideHeader: 'true',
      hideLiveBadge: 1,
      hideQualityBadge: null,
      hideCaption: {},
    });
    expect(sanitized).toEqual(DEFAULT_VOICE_FULLSCREEN_CHROME);
  });

  it('falls back to the defaults for garbage input', () => {
    for (const raw of [undefined, null, 'nope', 42, []]) {
      expect(sanitizeVoiceFullscreenChrome(raw)).toEqual(DEFAULT_VOICE_FULLSCREEN_CHROME);
    }
  });

  it('returns a new object so callers cannot mutate the shared defaults', () => {
    const sanitized = sanitizeVoiceFullscreenChrome(undefined);
    sanitized.hideHeader = true;
    expect(DEFAULT_VOICE_FULLSCREEN_CHROME.hideHeader).toBe(false);
    expect(Object.isFrozen(DEFAULT_VOICE_FULLSCREEN_CHROME)).toBe(true);
  });
});
