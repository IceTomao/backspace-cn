import path from 'node:path';
import { app, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { HdrNativeRuntime, type HdrVideoConfig } from './hdrNative';
import { validateHdrColor } from './hdrColor';

/** The webpage can select sources, never executables, shell arguments or paths. */
export function registerHdrNative(ipc: IpcMain, getWindow: () => BrowserWindow | null, getInstance: () => string): () => void {
  const generations = { publisher: 0, viewer: 0 };
  const leases = new Map<'publisher' | 'viewer', { identity: string; requestId: string; revoke: () => Promise<void> }>();
  const revoke = (kind: 'publisher' | 'viewer') => { const lease = leases.get(kind); leases.delete(kind); void lease?.revoke(); };
  const runtime = new HdrNativeRuntime(app.isPackaged ? path.join(process.resourcesPath, 'hdr') : path.join(__dirname, '../hdr-runtime'), event => {
    const requestId = leases.get(event.kind)?.requestId;
    revoke(event.kind);
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('hdr-native-event', { ...event, requestId });
  }, !app.isPackaged && process.env.BACKSPACE_HDR_LAB === '1');
  const trusted = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
        !event.senderFrame || !['https:', 'http:'].includes(new URL(event.senderFrame.url).protocol) ||
        new URL(event.senderFrame.url).origin !== new URL(getInstance()).origin) throw new Error('HDR request denied');
    return window;
  };
  const cancel = () => { generations.publisher++; generations.viewer++; runtime.dispose(); revoke('publisher'); revoke('viewer'); };
  const navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => { if (mainFrame && !inPlace) cancel(); };
  const window = getWindow();
  window?.webContents.on('did-start-navigation', navigation);
  window?.webContents.on('render-process-gone', cancel);
  window?.on('closed', cancel);
  ipc.handle('hdr-native-request', async (event, input: unknown) => {
    const owner = trusted(event);
    if (!input || typeof input !== 'object' || !('action' in input)) throw new Error('Invalid HDR request');
    const request = input as Record<string, unknown>;
    if (request.action === 'capabilities') return runtime.capabilities(request.probeEncoder === true);
    if (request.action === 'publisher-color') {
      const lease = leases.get('publisher');
      if (!lease || request.requestId !== lease.requestId) throw new Error('HDR publisher session expired');
      validateHdrColor(request.color);
      await runtime.setPublisherColor(request.color);
      trusted(event);
      if (leases.get('publisher') !== lease) throw new Error('HDR publisher session expired');
      return { ok: true };
    }
    if (request.action === 'viewer-audio') {
      runtime.setViewerAudio(request.volume as number, request.muted as boolean); return { ok: true };
    }
    if (request.action === 'stop') {
      if (request.kind !== 'publisher' && request.kind !== 'viewer') throw new Error('Invalid HDR operation');
      generations[request.kind]++; runtime.stop(request.kind); revoke(request.kind); return { ok: true };
    }
    if (request.action !== 'publish' && request.action !== 'view') throw new Error('Invalid HDR action');
    if (typeof request.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(request.requestId)) throw new Error('Invalid HDR request identity');
    if (typeof request.authToken !== 'string' || request.authToken.length > 16384 || !request.authToken ||
        typeof request.channelId !== 'string' || !request.channelId || request.channelId.length > 128 ||
        typeof request.isDm !== 'boolean') throw new Error('Invalid HDR voice session');
    if (request.action === 'publish' && typeof request.sourceId !== 'string') throw new Error('Missing HDR source');
    if (request.action === 'view' && (typeof request.publisher !== 'string' || !request.publisher.startsWith('__backspace_hdr_v1__'))) throw new Error('Invalid HDR publisher');
    const kind = request.action === 'publish' ? 'publisher' : 'viewer';
    const revision = ++generations[kind];
    runtime.stop(kind); revoke(kind);
    const role = request.action === 'publish' ? 'publish' : 'receive';
    const origin = new URL(getInstance()).origin;
    const response = await owner.webContents.session.fetch(`${origin}/api/livekit/token`, {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${request.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [request.isDm ? 'dmChannelId' : 'channelId']: request.channelId,
        nativeHdr: { role, ...(role === 'receive' ? { targetIdentity: request.publisher } : {}) } }),
    });
    if (!response.ok) throw new Error('HDR server authorization unavailable');
    const token = await response.json() as { token?: string; url?: string; nativeHdr?: { protocol?: number; identity?: string; role?: string; hasAudio?: boolean } };
    trusted(event);
    if (revision !== generations[kind] || token.nativeHdr?.protocol !== 1 || token.nativeHdr.role !== role ||
        typeof token.nativeHdr.identity !== 'string' || !token.nativeHdr.identity.startsWith('__backspace_hdr_v1__') ||
        typeof token.url !== 'string' || typeof token.token !== 'string') throw new Error('HDR server protocol unavailable');
    const credentials = { url: token.url, token: token.token, identity: token.nativeHdr.identity, hasAudio: token.nativeHdr.hasAudio === true };
    const session = owner.webContents.session;
    const publication = (trackSid: string | null) => session.fetch(`${origin}/api/livekit/hdr-publication`, {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${request.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: credentials.identity, trackSid }),
    });
    leases.set(kind, { identity: credentials.identity, requestId: request.requestId, revoke: async () => { try { await publication(null); } catch { /* server reconciliation also reaps it */ } } });
    try {
      if (request.action === 'publish') {
        const result = await runtime.startPublisher(request.sourceId as string, request.config as HdrVideoConfig, credentials);
        let confirmed = await publication(result.trackSid);
        // The SFU fills mimeType after receiving the first RTP, later than its
        // initial publish acknowledgement. Wait for that evidence, boundedly.
        for (let attempt = 0; !confirmed.ok && confirmed.status === 409 && attempt < 19 && revision === generations[kind]; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 200));
          if (revision !== generations[kind]) break;
          confirmed = await publication(result.trackSid);
        }
        trusted(event);
        if (!confirmed.ok || revision !== generations[kind]) throw new Error('HDR publication not confirmed by server');
        return result;
      }
      const handle = owner.getNativeWindowHandle();
      const ownerWindow = handle.length >= 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
      await runtime.startViewer(request.publisher as string, credentials, ownerWindow);
      trusted(event);
      if (revision !== generations[kind]) throw new Error('HDR viewer cancelled');
      return { ok: true };
    } catch (error) { if (revision === generations[kind]) { runtime.stop(kind); revoke(kind); } throw error; }
  });
  app.on('before-quit', cancel);
  return () => {
    cancel(); ipc.removeHandler('hdr-native-request'); app.off('before-quit', cancel);
    window?.webContents.off('did-start-navigation', navigation);
    window?.webContents.off('render-process-gone', cancel);
    window?.off('closed', cancel);
  };
}
