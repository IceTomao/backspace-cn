/** Public defaults for this distribution. Never put service credentials here. */
export const DESKTOP_BUILD: {
  defaultInstanceUrl: string;
  defaultLanguage: 'zh';
  updatesEnabled: boolean;
} = Object.freeze({
  // No operator instance is baked in: a fresh install must ask the user which
  // server to connect to instead of silently pointing at someone else's host.
  defaultInstanceUrl: '',
  defaultLanguage: 'zh',
  updatesEnabled: true,
});

/**
 * Resolves the instance to load. Priority: explicit override (BACKSPACE_URL),
 * then the saved choice, then the build default. Returns `null` when none is
 * configured so callers can show the instance picker instead of loading an
 * invalid URL.
 */
export function resolveInstanceUrl(override: string | undefined, saved: string | null): string | null {
  const candidates = [override, saved, DESKTOP_BUILD.defaultInstanceUrl];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}
