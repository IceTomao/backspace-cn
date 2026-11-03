import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ runtime: null as any }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { app: Object.assign(new EventEmitter(), { isPackaged: false }) };
});
vi.mock('./sdrNative', () => ({
  SdrNativeRuntime: class {
    capabilities = vi.fn().mockResolvedValue({ available: true, hevcAvailable: true, h264Available: true, displays: [] });
    startPublisher = vi.fn().mockResolvedValue({
      identity: '__backspace_hdr_v1__alice:publish:sdr',
      trackSid: 'TR_sdr_video',
      width: 2560,
      height: 1440,
      codec: 'hevc',
    });
    stop = vi.fn();
    dispose = vi.fn();
    setPublisherColor = vi.fn().mockResolvedValue(undefined);
    requestKeyFrame = vi.fn().mockReturnValue(true);
    constructor(
      _root: string,
      readonly notify: (value: unknown) => void,
      readonly onAudioChunk?: (chunk: unknown) => void,
    ) {
      state.runtime = this;
    }
  },
}));

import { registerSdrNative } from './sdrIpc';
import type { SdrCaptureTarget } from './sdrNative';

let handle: (event: any, input: any) => Promise<any>;
let windowObj: any;
let event: any;
let fetchMock: ReturnType<typeof vi.fn>;
let resolveTarget: ReturnType<typeof vi.fn<(sourceId: string) => Promise<SdrCaptureTarget | null>>>;
let dispose: () => void;

const identity = '__backspace_hdr_v1__alice:publish:sdr';
const tokenResponse = () => ({
  ok: true,
  json: async () => ({
    token: 'lk-sdr-token',
    url: 'wss://voice.example',
    nativeSdr: { protocol: 1, role: 'publish', identity },
  }),
});

beforeEach(() => {
  fetchMock = vi.fn().mockImplementation(async (url: string) =>
    url.endsWith('/token') ? tokenResponse() : { ok: true, status: 200 },
  );
  resolveTarget = vi.fn(async (sourceId: string): Promise<SdrCaptureTarget | null> => {
    if (sourceId === 'screen:0:0') {
      return {
        sourceId,
        physicalBounds: { x: 0, y: 0, width: 2560, height: 1440 },
        dipBounds: { x: 0, y: 0, width: 2560, height: 1440 },
        scaleFactor: 1,
        isPrimary: true,
        screenIndex: 0,
        totalScreens: 1,
      };
    }
    if (sourceId === 'window:263960:0') {
      return { kind: 'window', sourceId, hwnd: '263960' };
    }
    return null;
  });
  const webContents = Object.assign(new EventEmitter(), {
    mainFrame: { url: 'https://chat.example/voice' },
    session: { fetch: fetchMock },
    send: vi.fn(),
  });
  windowObj = Object.assign(new EventEmitter(), { webContents, isDestroyed: () => false });
  event = { sender: webContents, senderFrame: webContents.mainFrame };
  const ipc = {
    handle: (_name: string, handler: typeof handle) => { handle = handler; },
    removeHandler: vi.fn(),
  };
  dispose = registerSdrNative(ipc as any, () => windowObj, () => 'https://chat.example', resolveTarget);
});

afterEach(() => {
  dispose();
});

it('publishes enumerated window:* sources via zero-copy SDR and supports keyframe requests', async () => {
  const req = {
    action: 'publish',
    requestId: 'win-req-1',
    authToken: 'jwt-token',
    channelId: 'ch-1',
    isDm: false,
    sourceId: 'window:263960:0',
    config: { maxHeight: 1440, fps: 120, bitrateKbps: 25000, codec: 'hevc', shareAudio: true },
  };
  const res = await handle(event, req);
  expect(res).toEqual({
    identity,
    trackSid: 'TR_sdr_video',
    width: 2560,
    height: 1440,
    codec: 'hevc',
  });
  expect(resolveTarget).toHaveBeenCalledWith('window:263960:0');
  expect(state.runtime.startPublisher).toHaveBeenCalledWith(
    { kind: 'window', sourceId: 'window:263960:0', hwnd: '263960' },
    req.config,
    { url: 'wss://voice.example', token: 'lk-sdr-token', identity },
  );

  // Both 'keyframe' (sent by web store) and 'request-idr' trigger instant IDR for active lease
  await expect(handle(event, { action: 'keyframe', requestId: 'win-req-1' })).resolves.toEqual({ ok: true });
  await expect(handle(event, { action: 'request-idr', requestId: 'win-req-1' })).resolves.toEqual({ ok: true });
  expect(state.runtime.requestKeyFrame).toHaveBeenCalledTimes(2);
  await expect(handle(event, { action: 'keyframe', requestId: 'stale-req' })).resolves.toEqual({ ok: false });
});

it('rejects unenumerated window handles and unsupported source prefixes', async () => {
  const base = {
    action: 'publish',
    requestId: 'win-req-2',
    authToken: 'jwt-token',
    channelId: 'ch-1',
    isDm: false,
    config: { maxHeight: 1080, fps: 60, bitrateKbps: 12000, codec: 'hevc', shareAudio: false },
  };
  await expect(handle(event, { ...base, sourceId: 'hdr:DISPLAY1' })).rejects.toThrow('display or window source');
  await expect(handle(event, { ...base, sourceId: 'window:999999:0' })).rejects.toThrow('could not be resolved');
  expect(fetchMock).not.toHaveBeenCalled();
});
