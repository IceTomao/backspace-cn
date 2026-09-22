import { describe, expect, it } from 'vitest';
import { getLegacyActivity } from './activityCompatibility';

describe('getLegacyActivity', () => {
  it('keeps music visible to legacy clients while a game is primary', () => {
    expect(getLegacyActivity([
      { type: 'playing', name: 'League of Legends', state: '峡谷之巅' },
      { type: 'listening', name: 'Spotify', details: 'Song', state: 'Artist' },
    ])).toEqual({
      type: 'playing',
      name: 'League of Legends',
      state: '峡谷之巅 · 正在听 Spotify · Song · Artist',
    });
  });

  it('leaves music unchanged when it is primary', () => {
    const music = { type: 'listening' as const, name: '网易云音乐', details: '歌曲' };
    expect(getLegacyActivity([music])).toEqual(music);
  });
});
