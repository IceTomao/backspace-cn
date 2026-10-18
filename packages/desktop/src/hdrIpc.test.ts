import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ runtime: null as any }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { app: Object.assign(new EventEmitter(), { isPackaged: false }) };
});
vi.mock('./hdrNative', () => ({ HdrNativeRuntime: class {
  capabilities = vi.fn().mockResolvedValue({ available: false });
  startPublisher = vi.fn().mockResolvedValue({ identity: '__backspace_hdr_v1__alice:publish:session', trackSid: 'video' });
  startViewer = vi.fn().mockResolvedValue(undefined);
  stop = vi.fn(); dispose = vi.fn(); setViewerAudio = vi.fn(); setPublisherColor = vi.fn().mockResolvedValue(undefined);
  constructor(_root: string, readonly notify: (value: unknown) => void) { state.runtime = this; }
} }));
import { registerHdrNative } from './hdrIpc';

let handle: (event: any, input: any) => Promise<any>;
let window: any, event: any, fetch: ReturnType<typeof vi.fn>, dispose: () => void;
const identity = '__backspace_hdr_v1__alice:publish:session';
const publish = { action: 'publish', requestId: 'start-1', authToken: 'account-token', channelId: 'voice', isDm: false,
  sourceId: 'hdr:display', config: { width: 1920, height: 1080, fps: 60, bitrateKbps: 16000, shareAudio: false } };
const token = () => ({ ok: true, json: async () => ({ token: 'livekit-token', url: 'wss://voice.example', nativeHdr: { protocol: 1, role: 'publish', identity } }) });
beforeEach(() => {
  fetch = vi.fn().mockImplementation(async (url: string) => url.endsWith('/token') ? token() : { ok: true });
  const webContents = Object.assign(new EventEmitter(), { mainFrame: { url: 'https://chat.example/voice' }, session: { fetch }, send: vi.fn() });
  window = Object.assign(new EventEmitter(), { webContents, isDestroyed: () => false });
  event = { sender: webContents, senderFrame: webContents.mainFrame };
  const ipc = { handle: (_name: string, handler: typeof handle) => { handle = handler; }, removeHandler: vi.fn() };
  dispose = registerHdrNative(ipc as any, () => window, () => 'https://chat.example');
});
afterEach(() => { dispose(); });

it('denies child frames, foreign origins and unrecognized native actions', async () => {
  await expect(handle({ ...event, senderFrame: { url: 'https://chat.example/iframe' } }, { action: 'capabilities' })).rejects.toThrow('denied');
  event.senderFrame.url = 'https://other.example';
  await expect(handle(event, publish)).rejects.toThrow('denied');
  event.senderFrame.url = 'https://chat.example';
  await expect(handle(event, { action: 'execute', path: 'cmd.exe' })).rejects.toThrow('action');
  expect(fetch).not.toHaveBeenCalled();
});
it('obtains a scoped token itself and confirms the exact native video before returning success', async () => {
  await expect(handle(event, publish)).resolves.toEqual({ identity, trackSid: 'video' });
  expect(fetch.mock.calls[0]![0]).toBe('https://chat.example/api/livekit/token');
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ channelId: 'voice', nativeHdr: { role: 'publish' } });
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ identity, trackSid: 'video' });
  state.runtime.notify({ kind: 'publisher', state: 'stopped', reason: 'native_process_exited' });
  expect(window.webContents.send).toHaveBeenCalledWith('hdr-native-event', expect.objectContaining({ requestId: 'start-1', state: 'stopped' }));
});
it('does not start a late token response after stop or main-frame navigation', async () => {
  let finish!: (value: unknown) => void;
  fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = handle(event, publish);
  await handle(event, { action: 'stop', kind: 'publisher' });
  finish(token());
  await expect(pending).rejects.toThrow('protocol');
  expect(state.runtime.startPublisher).not.toHaveBeenCalled();
  window.webContents.emit('did-start-navigation', {}, 'https://chat.example/other', true, true);
  expect(state.runtime.dispose).not.toHaveBeenCalled();
  window.webContents.emit('did-start-navigation', {}, 'https://chat.example/other', false, true);
  expect(state.runtime.dispose).toHaveBeenCalledOnce();
});
it('fails closed on an old server or rejected publication confirmation', async () => {
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'legacy', url: 'wss://voice.example' }) });
  await expect(handle(event, publish)).rejects.toThrow('protocol');
  expect(state.runtime.startPublisher).not.toHaveBeenCalled();
  fetch.mockImplementation(async (url: string) => url.endsWith('/token') ? token() : { ok: false });
  await expect(handle(event, publish)).rejects.toThrow('not confirmed');
  expect(state.runtime.stop).toHaveBeenCalledWith('publisher');
  expect(JSON.parse(fetch.mock.calls.at(-1)![1].body)).toEqual({ identity, trackSid: null });
});
it('binds color control to the exact publisher lease and rejects invalid settings', async () => {
  const adjustment = { action: 'publisher-color', requestId: 'start-1', color: { exposureEv: 1.2, brightness: 25 } };
  await expect(handle(event, adjustment)).rejects.toThrow('expired');
  await handle(event, publish);
  await expect(handle(event, { ...adjustment, requestId: 'old-session' })).rejects.toThrow('expired');
  await expect(handle(event, { ...adjustment, color: { exposureEv: 10, brightness: 25 } })).rejects.toThrow('Invalid');
  expect(state.runtime.setPublisherColor).not.toHaveBeenCalled();
  await expect(handle(event, adjustment)).resolves.toEqual({ ok: true });
  expect(state.runtime.setPublisherColor).toHaveBeenCalledWith(adjustment.color);
  await handle(event, { action: 'stop', kind: 'publisher' });
  await expect(handle(event, adjustment)).rejects.toThrow('expired');
});
