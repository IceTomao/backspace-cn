import path from 'node:path';
import { app, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { SdrNativeRuntime, type SdrCaptureTarget, type SdrVideoConfig } from './sdrNative';
import { validateHdrColor } from './hdrColor';

/**
 * Trusted main-process IPC bridge for Native Zero-Copy SDR display & window capture.
 * The renderer supplies only enumerated screen/window source IDs and bounded numeric
 * parameters, never executable paths, shell arguments, or unverified OS handles.
 */
export function registerSdrNative(
  ipc: IpcMain,
  getWindow: () => BrowserWindow | null,
  getInstance: () => string,
  resolveCaptureTarget: (sourceId: string) => Promise<SdrCaptureTarget | null>,
): () => void {
  let generation = 0;
  let activeLease: { identity: string; requestId: string; revoke: () => Promise<void> } | null = null;

  const revokeLease = (lease: typeof activeLease) => {
    if (!lease) return;
    if (activeLease === lease) activeLease = null;
    void lease.revoke();
  };

  const runtime = new SdrNativeRuntime(
    app.isPackaged ? path.join(process.resourcesPath, 'hdr') : path.join(__dirname, '../hdr-runtime'),
    event => {
      const window = getWindow();
      if (!window || window.isDestroyed()) return;
      const requestId = activeLease?.requestId;
      if (event.kind === 'publisher' && event.state === 'stopped') {
        revokeLease(activeLease);
      }
      window.webContents.send('sdr-native-event', { ...event, requestId });
    },
    audioChunk => {
      const window = getWindow();
      if (!window || window.isDestroyed() || !activeLease) return;
      window.webContents.send('sdr-native-audio', { ...audioChunk, requestId: activeLease.requestId });
    },
  );

  const trusted = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = getWindow();
    if (!window || window.isDestroyed() ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        !event.senderFrame ||
        !['https:', 'http:'].includes(new URL(event.senderFrame.url).protocol) ||
        new URL(event.senderFrame.url).origin !== new URL(getInstance()).origin) {
      throw new Error('SDR request denied');
    }
    return window;
  };

  const cancel = () => {
    generation++;
    runtime.dispose();
    revokeLease(activeLease);
  };

  const navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame && !inPlace) cancel();
  };

  const window = getWindow();
  window?.webContents.on('did-start-navigation', navigation);
  window?.webContents.on('render-process-gone', cancel);
  window?.on('closed', cancel);

  ipc.handle('sdr-native-request', async (event, input: unknown) => {
    const owner = trusted(event);
    if (!input || typeof input !== 'object' || !('action' in input)) {
      throw new Error('Invalid SDR request');
    }
    const request = input as Record<string, unknown>;

    if (request.action === 'capabilities') {
      return runtime.capabilities(request.probeEncoder === true);
    }

    if (request.action === 'publisher-color') {
      if (!activeLease || request.requestId !== activeLease.requestId) {
        throw new Error('SDR publisher session expired');
      }
      const leaseSnapshot = activeLease;
      validateHdrColor(request.color);
      await runtime.setPublisherColor(request.color);
      trusted(event);
      if (activeLease !== leaseSnapshot) throw new Error('SDR publisher session expired');
      return { ok: true };
    }

    if (request.action === 'request-idr' || request.action === 'keyframe') {
      if (!activeLease || (typeof request.requestId === 'string' && request.requestId !== activeLease.requestId)) {
        return { ok: false };
      }
      return { ok: runtime.requestKeyFrame() };
    }

    if (request.action === 'stop') {
      generation++;
      runtime.stop();
      revokeLease(activeLease);
      return { ok: true };
    }

    if (request.action !== 'publish') {
      throw new Error('Invalid SDR action');
    }

    if (typeof request.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(request.requestId)) {
      throw new Error('Invalid SDR request identity');
    }
    if (typeof request.authToken !== 'string' || !request.authToken || request.authToken.length > 16384 ||
        typeof request.channelId !== 'string' || !request.channelId || request.channelId.length > 128 ||
        typeof request.isDm !== 'boolean') {
      throw new Error('Invalid SDR voice session');
    }
    if (
      typeof request.sourceId !== 'string' ||
      (!request.sourceId.startsWith('screen:') && !request.sourceId.startsWith('window:'))
    ) {
      throw new Error('SDR zero-copy requires a display or window source');
    }

    const revision = ++generation;
    const previousLease = activeLease;
    activeLease = null;
    runtime.stop();

    const captureTarget = await resolveCaptureTarget(request.sourceId);
    if (!captureTarget) {
      revokeLease(previousLease);
      throw new Error('Selected capture source could not be resolved');
    }

    const origin = new URL(getInstance()).origin;
    const session = owner.webContents.session;
    let newLease: { identity: string; requestId: string; revoke: () => Promise<void> } | null = null;

    try {
      const response = await session.fetch(`${origin}/api/livekit/token`, {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${request.authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          [request.isDm ? 'dmChannelId' : 'channelId']: request.channelId,
          nativeSdr: { role: 'publish' },
        }),
      });
      if (!response.ok) throw new Error('SDR server authorization unavailable');

      const token = await response.json() as {
        token?: string;
        url?: string;
        nativeSdr?: { protocol?: number; identity?: string; role?: string };
      };
      trusted(event);
      if (revision !== generation ||
          token.nativeSdr?.protocol !== 1 ||
          token.nativeSdr.role !== 'publish' ||
          typeof token.nativeSdr.identity !== 'string' ||
          !token.nativeSdr.identity.startsWith('__backspace_hdr_v1__') ||
          typeof token.url !== 'string' ||
          typeof token.token !== 'string') {
        throw new Error('SDR server protocol unavailable');
      }

      const credentials = { url: token.url, token: token.token, identity: token.nativeSdr.identity };
      const publication = (trackSid: string | null) =>
        session.fetch(`${origin}/api/livekit/sdr-publication`, {
          method: 'POST',
          redirect: 'error',
          credentials: 'omit',
          signal: AbortSignal.timeout(15000),
          headers: { Authorization: `Bearer ${request.authToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ identity: credentials.identity, trackSid }),
        });

      newLease = {
        identity: credentials.identity,
        requestId: request.requestId,
        revoke: async () => {
          try { await publication(null); } catch { /* server reconciliation also reaps it */ }
        },
      };
      activeLease = newLease;

      const result = await runtime.startPublisher(captureTarget, request.config as SdrVideoConfig, credentials);
      let confirmed = await publication(result.trackSid);
      for (let attempt = 0; !confirmed.ok && confirmed.status === 409 && attempt < 19 && revision === generation; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        if (revision !== generation) break;
        confirmed = await publication(result.trackSid);
      }
      trusted(event);
      if (!confirmed.ok || revision !== generation) {
        throw new Error('SDR publication not confirmed by server');
      }

      // Revoke any replaced session AFTER the new session is confirmed so the
      // server never broadcasts a transient isScreenSharing=false during hot-switch.
      revokeLease(previousLease);
      return result;
    } catch (error) {
      revokeLease(previousLease);
      if (revision === generation) {
        runtime.stop();
        revokeLease(newLease);
      }
      throw error;
    }
  });

  app.on('before-quit', cancel);
  return () => {
    cancel();
    ipc.removeHandler('sdr-native-request');
    app.off('before-quit', cancel);
    window?.webContents.off('did-start-navigation', navigation);
    window?.webContents.off('render-process-gone', cancel);
    window?.off('closed', cancel);
  };
}
