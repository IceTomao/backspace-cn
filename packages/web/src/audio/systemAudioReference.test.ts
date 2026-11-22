import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildReferenceCaptureOptions,
  chooseReferenceSource,
  stripVideoTracks,
} from './systemAudioReference';

interface FakeTrack {
  kind: 'audio' | 'video';
  onended: (() => void) | null;
  stop: () => void;
}

function makeTrack(kind: 'audio' | 'video'): FakeTrack {
  return { kind, onended: null, stop: vi.fn() };
}

function makeStream(tracks: FakeTrack[]): MediaStream {
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
  } as unknown as MediaStream;
}

class FakeMediaStream {
  constructor(public readonly tracks: FakeTrack[]) {}
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === 'audio');
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === 'video');
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chooseReferenceSource', () => {
  it('prefers a whole screen over a window', () => {
    const sources = [
      { id: 'window:12:0', name: 'Editor' },
      { id: 'screen:0:0', name: 'Display 1' },
    ];
    expect(chooseReferenceSource(sources)?.id).toBe('screen:0:0');
  });

  it('falls back to the first source and reports nothing when empty', () => {
    expect(chooseReferenceSource([{ id: 'window:1:0' }])?.id).toBe('window:1:0');
    expect(chooseReferenceSource([])).toBeNull();
  });
});

describe('buildReferenceCaptureOptions', () => {
  it('requests audio without excluding the app’s own playback', () => {
    const options = buildReferenceCaptureOptions();
    expect(options.video).toBe(true);
    const audio = options.audio as MediaTrackConstraints;
    expect((audio as unknown as Record<string, unknown>).restrictOwnAudio).toBeUndefined();
    expect(audio.echoCancellation).toBe(false);
    expect(audio.noiseSuppression).toBe(false);
    expect(audio.autoGainControl).toBe(false);
  });
});

describe('stripVideoTracks', () => {
  it('stops the video half and keeps a live audio-only stream', () => {
    vi.stubGlobal('MediaStream', FakeMediaStream);
    const video = makeTrack('video');
    const audio = makeTrack('audio');
    const stream = makeStream([video, audio]);

    const result = stripVideoTracks(stream);

    expect(video.stop).toHaveBeenCalledTimes(1);
    expect(audio.stop).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result?.getAudioTracks()).toHaveLength(1);
    expect(result?.getVideoTracks()).toHaveLength(0);
  });

  it('returns null and releases everything when the capture has no audio', () => {
    vi.stubGlobal('MediaStream', FakeMediaStream);
    const video = makeTrack('video');
    const stream = makeStream([video]);

    expect(stripVideoTracks(stream)).toBeNull();
    expect(video.stop).toHaveBeenCalledTimes(1);
  });
});
