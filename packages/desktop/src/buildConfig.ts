/** Public defaults for this distribution. Never put service credentials here. */
export const DESKTOP_BUILD: {
  defaultInstanceUrl: string;
  defaultLanguage: 'zh';
  updatesEnabled: boolean;
} = Object.freeze({
  defaultInstanceUrl: 'https://chat.kevz.me:2096',
  defaultLanguage: 'zh',
  updatesEnabled: false,
});

export function resolveInstanceUrl(override: string | undefined, saved: string | null): string {
  return override || saved || DESKTOP_BUILD.defaultInstanceUrl;
}
