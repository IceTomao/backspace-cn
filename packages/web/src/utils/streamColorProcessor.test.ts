import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cloneStreamColor,
  DEFAULT_STREAM_COLOR,
  type StreamColorSettings,
} from './streamColor';
import {
  attachStreamColorProcessor,
  getUnderlyingCaptureTrack,
  type StreamColorSurfaceRenderer,
} from './streamColorProcessor';

interface MockFrame {
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  timestamp: number;
  duration: number | null;
  source?: unknown;
  closed: boolean;
  close: ReturnType<typeof vi.fn>;
}

function createMockFrame(timestamp: number, duration: number | null = 16666): MockFrame {
  const frame: MockFrame = {
    codedWidth: 1920,
    codedHeight: 1080,
    displayWidth: 1920,
    displayHeight: 1080,
    timestamp,
    duration,
    closed: false,
    close: vi.fn(() => {
      frame.closed = true;
    }),
  };
  return frame;
}

describe('attachStreamColorProcessor', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('passes raw VideoFrames through untouched when settings are default, and renders via WebGL when modified', async () => {
    let pushFrame!: (frame: MockFrame) => void;
    let closeInput!: () => void;
    const outputFrames: MockFrame[] = [];

    const rawVideoListeners = new Map<string, Set<EventListener>>();
    const rawVideoTrack = {
      kind: 'video',
      id: 'raw-video-track',
      readyState: 'live',
      contentHint: 'motion',
      stop: vi.fn(),
      addEventListener: vi.fn((type: string, cb: EventListener) => {
        if (!rawVideoListeners.has(type)) rawVideoListeners.set(type, new Set());
        rawVideoListeners.get(type)!.add(cb);
      }),
      removeEventListener: vi.fn((type: string, cb: EventListener) => {
        rawVideoListeners.get(type)?.delete(cb);
      }),
    } as unknown as MediaStreamTrack;

    const audioTrack = {
      kind: 'audio',
      id: 'raw-audio-track',
      readyState: 'live',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;

    const generatorNativeStop = vi.fn();
    const generatorDispatchEvent = vi.fn();

    vi.stubGlobal(
      'MediaStreamTrackProcessor',
      class {
        readable: ReadableStream<MockFrame>;
        constructor() {
          this.readable = new ReadableStream<MockFrame>({
            start(controller) {
              pushFrame = (f) => controller.enqueue(f);
              closeInput = () => controller.close();
            },
          });
        }
      },
    );

    vi.stubGlobal(
      'MediaStreamTrackGenerator',
      class {
        kind = 'video';
        id = 'processed-video-track';
        readyState = 'live';
        contentHint = '';
        stop = generatorNativeStop;
        dispatchEvent = generatorDispatchEvent;
        writable: WritableStream<MockFrame>;
        constructor() {
          this.writable = new WritableStream<MockFrame>({
            write(frame) {
              outputFrames.push(frame);
            },
          });
        }
      },
    );

    vi.stubGlobal(
      'VideoFrame',
      class {
        codedWidth = 1920;
        codedHeight = 1080;
        displayWidth = 1920;
        displayHeight = 1080;
        timestamp: number;
        duration: number | null;
        source: unknown;
        closed = false;
        close = vi.fn();
        constructor(source: unknown, init: { timestamp: number; duration?: number }) {
          this.source = source;
          this.timestamp = init.timestamp;
          this.duration = init.duration ?? null;
        }
      },
    );

    vi.stubGlobal(
      'MediaStream',
      class {
        constructor(private tracks: MediaStreamTrack[]) {}
        getTracks() {
          return this.tracks;
        }
        getVideoTracks() {
          return this.tracks.filter((t) => t.kind === 'video');
        }
        getAudioTracks() {
          return this.tracks.filter((t) => t.kind === 'audio');
        }
      },
    );

    const mockSurface = { width: 2, height: 2 } as unknown as OffscreenCanvas;
    const mockRenderer: StreamColorSurfaceRenderer = {
      surface: mockSurface,
      render: vi.fn(() => true),
      dispose: vi.fn(),
    };
    const rendererFactory = vi.fn(() => mockRenderer);

    let currentColor: StreamColorSettings = cloneStreamColor(DEFAULT_STREAM_COLOR);
    const subscribers = new Set<(c: StreamColorSettings) => void>();

    const rawStream = new MediaStream([rawVideoTrack, audioTrack]);
    const processedStream = attachStreamColorProcessor(rawStream, {
      getColor: () => currentColor,
      subscribe: (cb) => {
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
      rendererFactory,
    });

    const processedVideoTrack = processedStream.getVideoTracks()[0]!;
    expect(processedVideoTrack.id).toBe('processed-video-track');
    expect(processedVideoTrack.contentHint).toBe('motion');
    expect(processedStream.getAudioTracks()).toEqual([audioTrack]);
    expect(getUnderlyingCaptureTrack(processedVideoTrack)).toBe(rawVideoTrack);

    // 1. Default color: zero-copy pass-through, WebGL renderer not even allocated
    const frame1 = createMockFrame(1000);
    pushFrame(frame1);
    await vi.waitFor(() => expect(outputFrames).toHaveLength(1));
    expect(outputFrames[0]).toBe(frame1);
    expect(frame1.closed).toBe(false);
    expect(rendererFactory).not.toHaveBeenCalled();

    // 2. Live color update: allocates renderer, renders, creates output VideoFrame, closes input frame
    const modified = cloneStreamColor(DEFAULT_STREAM_COLOR);
    modified.red.brightness = 70;
    modified.digitalVibrance = 80;
    currentColor = modified;
    for (const sub of subscribers) sub(modified);

    const frame2 = createMockFrame(2000, 16667);
    pushFrame(frame2);
    await vi.waitFor(() => expect(outputFrames).toHaveLength(2));
    expect(rendererFactory).toHaveBeenCalledOnce();
    expect(mockRenderer.render).toHaveBeenCalledOnce();
    expect(frame2.close).toHaveBeenCalledOnce();
    expect(outputFrames[1]).not.toBe(frame2);
    expect(outputFrames[1]!.timestamp).toBe(2000);
    expect(outputFrames[1]!.duration).toBe(16667);

    // 3. Stopping the processed track stops the underlying OS capture track and disposes WebGL
    processedVideoTrack.stop();
    expect(rawVideoTrack.stop).toHaveBeenCalledOnce();
    expect(generatorNativeStop).toHaveBeenCalledOnce();
    expect(mockRenderer.dispose).toHaveBeenCalledOnce();
    closeInput();
  });

  it('propagates OS stop-sharing (`ended`) from raw capture track to the processed track without re-stopping raw', () => {
    const rawVideoListeners = new Map<string, Set<EventListener>>();
    const rawVideoTrack = {
      kind: 'video',
      id: 'raw-video-track',
      readyState: 'live',
      stop: vi.fn(),
      addEventListener: vi.fn((type: string, cb: EventListener) => {
        if (!rawVideoListeners.has(type)) rawVideoListeners.set(type, new Set());
        rawVideoListeners.get(type)!.add(cb);
      }),
      removeEventListener: vi.fn((type: string, cb: EventListener) => {
        rawVideoListeners.get(type)?.delete(cb);
      }),
    } as unknown as MediaStreamTrack;

    const generatorDispatchEvent = vi.fn();
    vi.stubGlobal(
      'MediaStreamTrackProcessor',
      class {
        readable = new ReadableStream();
      },
    );
    vi.stubGlobal(
      'MediaStreamTrackGenerator',
      class {
        kind = 'video';
        readyState = 'live';
        stop = vi.fn();
        dispatchEvent = generatorDispatchEvent;
        writable = new WritableStream();
      },
    );
    vi.stubGlobal('VideoFrame', class {});
    vi.stubGlobal(
      'MediaStream',
      class {
        constructor(private tracks: MediaStreamTrack[]) {}
        getVideoTracks() {
          return this.tracks;
        }
        getAudioTracks() {
          return [];
        }
      },
    );

    attachStreamColorProcessor(new MediaStream([rawVideoTrack]), {
      getColor: () => DEFAULT_STREAM_COLOR,
      subscribe: () => () => {},
      rendererFactory: () => null,
    });

    for (const listener of rawVideoListeners.get('ended') ?? []) {
      listener(new Event('ended'));
    }

    expect(rawVideoTrack.stop).not.toHaveBeenCalled();
    expect(generatorDispatchEvent).toHaveBeenCalledOnce();
  });

  it('falls back safely to the raw stream when neither Insertable Streams nor WebGL2 captureStream is available', () => {
    const rawVideoTrack = { kind: 'video', readyState: 'live', stop: vi.fn() } as unknown as MediaStreamTrack;
    const rawStream = {
      getVideoTracks: () => [rawVideoTrack],
      getAudioTracks: () => [],
    } as unknown as MediaStream;

    const result = attachStreamColorProcessor(rawStream, {
      getColor: () => DEFAULT_STREAM_COLOR,
      subscribe: () => () => {},
      rendererFactory: () => null,
    });

    expect(result).toBe(rawStream);
    expect(getUnderlyingCaptureTrack(rawVideoTrack)).toBe(rawVideoTrack);
  });
});
