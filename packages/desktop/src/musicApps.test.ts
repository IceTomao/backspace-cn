import { describe, expect, it } from 'vitest';
import { getMusicApp } from './musicApps';

describe('getMusicApp', () => {
  it.each([
    ['Spotify.exe', 'Spotify'],
    ['AppleMusic.exe', 'Apple Music'],
    ['cloudmusic.exe', '网易云音乐'],
    ['QQMusic.exe', 'QQ 音乐'],
  ])('maps %s to its branded player', (source, name) => {
    const app = getMusicApp(source);
    expect(app?.name).toBe(name);
    expect(app?.iconUrl).toMatch(/^https:\/\//);
  });

  it('does not publish unknown players', () => {
    expect(getMusicApp('unknown-player.exe')).toBeNull();
  });
});
