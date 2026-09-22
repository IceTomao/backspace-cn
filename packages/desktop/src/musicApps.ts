export interface MusicApp {
  name: string;
  iconUrl: string;
}

const MUSIC_APPS: Array<{ pattern: RegExp; app: MusicApp }> = [
  { pattern: /spotify/i, app: { name: 'Spotify', iconUrl: 'https://cdn.simpleicons.org/spotify/1DB954' } },
  { pattern: /apple.*music|music.*apple/i, app: { name: 'Apple Music', iconUrl: 'https://cdn.simpleicons.org/applemusic/FA243C' } },
  { pattern: /cloudmusic|netease/i, app: { name: '网易云音乐', iconUrl: 'https://cdn.simpleicons.org/neteasecloudmusic/E60026' } },
  // The site's /mediastyle/.../logo.png is the generic QQ web logo. Use QQ
  // Music's own favicon, which contains the green/yellow music-note mark.
  { pattern: /qqmusic|qq.*music/i, app: { name: 'QQ 音乐', iconUrl: 'https://y.qq.com/favicon.ico' } },
];

/** Returns the supported player identity without exposing SMTC's raw app ID. */
export function getMusicApp(source: string | undefined): MusicApp | null {
  if (!source) return null;
  return MUSIC_APPS.find(({ pattern }) => pattern.test(source))?.app ?? null;
}
