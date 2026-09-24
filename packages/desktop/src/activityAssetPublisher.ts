import { createHash } from 'node:crypto';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import sharp from 'sharp';

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;
const CACHE_REFRESH_MS = 24 * 60 * 60 * 1000;

interface UploadSession {
  origin: string;
  token: string;
}

export class ActivityAssetPublisher {
  private session: UploadSession | null = null;
  private clientEnabled = false;
  private preferenceEnabled = true;
  private unsupported = false;
  private revision = 0;
  private cache = new Map<string, { url: string; uploadedAt: number }>();
  private controllers = new Set<AbortController>();
  private listeners = new Set<() => void>();

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setPreferenceEnabled(enabled: boolean): void {
    if (this.preferenceEnabled === enabled) return;
    this.preferenceEnabled = enabled;
    if (!enabled) this.cancelPending();
    this.notify();
  }

  setSession(session: UploadSession | null, clientEnabled: boolean): void {
    const changed = this.session?.origin !== session?.origin
      || this.session?.token !== session?.token
      || this.clientEnabled !== clientEnabled;
    if (!changed) return;
    this.cancelPending();
    this.session = session;
    this.clientEnabled = clientEnabled;
    this.unsupported = false;
    this.cache.clear();
    this.notify();
  }

  canPublish(): boolean {
    return Boolean(this.session && this.clientEnabled && this.preferenceEnabled && !this.unsupported);
  }

  async publish(source: Buffer): Promise<string | null> {
    if (!this.canPublish() || !source.length || source.length > MAX_SOURCE_BYTES) return null;
    const current = this.session!;
    const expectedRevision = this.revision;
    let normalized: Buffer;
    try {
      normalized = await sharp(source, { failOn: 'warning', limitInputPixels: 16_777_216 })
        .rotate()
        .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82, effort: 4 })
        .toBuffer();
    } catch { return null; }
    if (normalized.length > MAX_OUTPUT_BYTES || expectedRevision !== this.revision || !this.canPublish()) return null;

    const hash = createHash('sha256').update(normalized).digest('hex');
    const cached = this.cache.get(hash);
    if (cached && Date.now() - cached.uploadedAt < CACHE_REFRESH_MS) return cached.url;
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return null;
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const response = await win.webContents.session.fetch(`${current.origin}/api/activity-assets`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${current.token}`,
          'Content-Type': 'application/octet-stream',
        },
        body: normalized.buffer.slice(
          normalized.byteOffset,
          normalized.byteOffset + normalized.byteLength,
        ) as ArrayBuffer,
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status === 404 || response.status === 405) this.unsupported = true;
      if (!response.ok || expectedRevision !== this.revision) return null;
      const result = await response.json() as { url?: unknown };
      if (typeof result.url !== 'string' || !/^https?:\/\//.test(result.url) || result.url.length > 512) return null;
      this.cache.set(hash, { url: result.url, uploadedAt: Date.now() });
      return result.url;
    } catch { return null; }
    finally { this.controllers.delete(controller); }
  }

  dispose(): void {
    this.cancelPending();
    this.session = null;
    this.listeners.clear();
  }

  private cancelPending(): void {
    this.revision++;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export function registerActivityAssetSession(
  ipc: IpcMain,
  publisher: ActivityAssetPublisher,
  getWindow: () => BrowserWindow | null,
  getInstance: () => string,
): () => void {
  const channel = 'set-activity-asset-session';
  const validateSender = (event: IpcMainInvokeEvent): string => {
    const win = getWindow();
    if (!win || win.isDestroyed() || event.sender !== win.webContents
      || !event.senderFrame || event.senderFrame !== win.webContents.mainFrame) throw new Error('Activity session rejected');
    const source = new URL(event.senderFrame.url);
    const configured = new URL(getInstance());
    if (!['https:', 'http:'].includes(source.protocol) || source.origin !== configured.origin) {
      throw new Error('Activity session origin rejected');
    }
    return source.origin;
  };
  ipc.handle(channel, async (event, input: unknown) => {
    const origin = validateSender(event);
    if (!input || typeof input !== 'object') throw new Error('Invalid activity session');
    const value = input as Record<string, unknown>;
    const enabled = value.enabled === true;
    if (value.token === null || !enabled) {
      publisher.setSession(null, false);
      return { ok: true };
    }
    if (typeof value.token !== 'string' || !value.token || value.token.length > 16_384) {
      throw new Error('Invalid activity session token');
    }
    publisher.setSession({ origin, token: value.token }, true);
    return { ok: true };
  });
  return () => {
    publisher.dispose();
    ipc.removeHandler(channel);
  };
}
