import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import sharp from 'sharp';

export const FAVORITE_IMAGE_LIMIT = 20 * 1024 * 1024;
const CHANNEL = 'desktop-favorite-images';
const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const;
type Extension = keyof typeof MIME;
export interface FavoriteImage {
  id: string;
  name: string;
  extension: Extension;
  mime: string;
  size: number;
  addedAt: number;
}
interface AccountSession {
  id: string;
  scope: string;
  origin: string;
  token: string;
}

function imageExtension(bytes: Buffer): Extension {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  throw new Error('仅支持 PNG、JPG、WebP、GIF 图片');
}

/** Content-addressed files never contain renderer-provided path components. */
export class FavoriteImageStore {
  constructor(private readonly root: string) {}

  private directory(scope: string): string {
    return path.join(this.root, createHash('sha256').update(scope).digest('hex'));
  }

  list(scope: string): FavoriteImage[] {
    const file = path.join(this.directory(scope), 'index.json');
    if (!fs.existsSync(file)) return [];
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1 ||
        !('items' in parsed) || !Array.isArray(parsed.items)) throw new Error('收藏索引损坏，请保留数据并联系维护者');
    const ids = new Set<string>();
    for (const item of parsed.items) {
      if (!item || typeof item !== 'object' || !/^[a-f0-9]{64}$/.test(item.id) ||
          !Object.hasOwn(MIME, item.extension) || item.mime !== MIME[item.extension as Extension] ||
          typeof item.name !== 'string' || item.name.length > 180 ||
          !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > FAVORITE_IMAGE_LIMIT ||
          !Number.isSafeInteger(item.addedAt) || ids.has(item.id)) {
        throw new Error('收藏索引损坏，请保留数据并联系维护者');
      }
      ids.add(item.id);
    }
    return parsed.items as FavoriteImage[];
  }

  private saveIndex(scope: string, items: FavoriteImage[]): void {
    const directory = this.directory(scope);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, items }), { flag: 'wx' });
      fs.renameSync(temporary, path.join(directory, 'index.json'));
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  async add(scope: string, bytes: Buffer, filename: string, active: () => void): Promise<boolean> {
    if (!bytes.length || bytes.length > FAVORITE_IMAGE_LIMIT) throw new Error('单张图片不能超过 20 MiB');
    const extension = imageExtension(bytes);
    try {
      // Decode only for validation; the original bytes (including animation) are stored.
      await sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' }).stats();
    } catch {
      throw new Error('图片损坏或尺寸过大');
    }
    active();
    const items = this.list(scope);
    const id = createHash('sha256').update(bytes).digest('hex');
    if (items.some((item) => item.id === id)) return false;
    const directory = this.directory(scope);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${id}.${extension}`);
    if (!fs.existsSync(file)) {
      const temporary = path.join(directory, `${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, bytes, { flag: 'wx' });
        fs.renameSync(temporary, file);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    }
    const basename = path.basename(filename).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').slice(0, 160);
    const name = `${basename.replace(/\.[^.]*$/, '') || '表情'}.${extension}`;
    this.saveIndex(scope, [{ id, name, extension, mime: MIME[extension], size: bytes.length, addedAt: Date.now() }, ...items]);
    return true;
  }

  read(scope: string, id: string): { item: FavoriteImage; bytes: Uint8Array } {
    const item = this.list(scope).find((entry) => entry.id === id);
    if (!item) throw new Error('该表情已移除');
    const file = path.join(this.directory(scope), `${item.id}.${item.extension}`);
    if (fs.statSync(file).size !== item.size) throw new Error('收藏图片损坏');
    const bytes = fs.readFileSync(file);
    if (createHash('sha256').update(bytes).digest('hex') !== item.id) throw new Error('收藏图片损坏');
    return { item, bytes: new Uint8Array(bytes) };
  }

  remove(scope: string, id: string): void {
    const items = this.list(scope);
    const item = items.find((entry) => entry.id === id);
    if (!item) return;
    this.saveIndex(scope, items.filter((entry) => entry.id !== id));
    // A failed file cleanup must not restore a removed entry.
    try { fs.unlinkSync(path.join(this.directory(scope), `${item.id}.${item.extension}`)); } catch { /* orphan is harmless */ }
  }
}

export function registerFavoriteImages(
  ipc: IpcMain, getWindow: () => BrowserWindow | null, getInstance: () => string, root: string,
  assets: { script: string; styles: string },
): () => void {
  const store = new FavoriteImageStore(root);
  let account: AccountSession | null = null;
  let revision = 0;
  const controllers = new Set<AbortController>();
  const reset = () => {
    revision++;
    account = null;
    for (const controller of controllers) controller.abort();
    controllers.clear();
  };
  const windowFor = (event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>): BrowserWindow => {
    const win = getWindow();
    if (!win || win.isDestroyed() || event.sender !== win.webContents ||
        !event.senderFrame || event.senderFrame !== win.webContents.mainFrame) throw new Error('收藏请求被拒绝');
    const source = new URL(event.senderFrame.url);
    if (!['https:', 'http:'].includes(source.protocol) || source.origin !== new URL(getInstance()).origin) {
      throw new Error('收藏请求来源无效');
    }
    return win;
  };
  const bootstrap = (event: Electron.IpcMainEvent) => {
    try { windowFor(event); event.returnValue = assets; } catch { event.returnValue = null; }
  };
  ipc.on('desktop-favorites-bootstrap', bootstrap);
  ipc.handle(CHANNEL, async (event, request: unknown) => {
    try {
      const win = windowFor(event);
      if (!request || typeof request !== 'object' || !('action' in request)) throw new Error('收藏请求无效');
      const input = request as Record<string, unknown>;
      if (input.action === 'session') {
        reset();
        if (input.token === null) return { ok: true, session: null };
        if (typeof input.token !== 'string' || !input.token || input.token.length > 16384) throw new Error('请先登录');
        const origin = new URL(event.senderFrame!.url).origin;
        const expected = revision;
        const controller = new AbortController();
        controllers.add(controller);
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await win.webContents.session.fetch(`${origin}/api/users/@me`, {
            headers: { Authorization: `Bearer ${input.token}` }, credentials: 'omit',
            redirect: 'error', signal: controller.signal,
          });
          if (!response.ok) throw new Error('无法确认当前账号，请重新登录或稍后重试');
          const user = await response.json() as { id?: unknown };
          if (typeof user.id !== 'string' || !user.id || user.id.length > 256) throw new Error('账号信息无效');
          if (expected !== revision) throw new Error('账号已切换');
          windowFor(event);
          account = { id: randomUUID(), scope: JSON.stringify([origin, user.id]), origin, token: input.token };
          return { ok: true, session: account.id };
        } finally {
          clearTimeout(timeout);
          controllers.delete(controller);
        }
      }
      const current = account;
      if (!current || input.session !== current.id) throw new Error('账号已切换，请重新打开收藏');
      const active = () => {
        windowFor(event);
        if (account !== current || new URL(event.senderFrame!.url).origin !== current.origin) {
          throw new Error('账号已切换，操作已取消');
        }
      };
      active();
      if (input.action === 'list') return { ok: true, items: store.list(current.scope) };
      if (input.action === 'read' || input.action === 'remove') {
        if (typeof input.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.id)) throw new Error('表情标识无效');
        if (input.action === 'read') return { ok: true, ...store.read(current.scope, input.id) };
        store.remove(current.scope, input.id);
        return { ok: true };
      }
      if (input.action === 'import') {
        const selection = await dialog.showOpenDialog(win, {
          title: '添加到我的收藏', properties: ['openFile', 'multiSelections'],
          filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
        });
        active();
        if (selection.canceled) return { ok: true, canceled: true };
        let added = 0;
        let duplicates = 0;
        const failures: string[] = [];
        for (const file of selection.filePaths) {
          active();
          try {
            const stat = fs.statSync(file);
            if (!stat.isFile() || stat.size > FAVORITE_IMAGE_LIMIT) throw new Error('单张图片不能超过 20 MiB');
            if (await store.add(current.scope, fs.readFileSync(file), path.basename(file), active)) added++; else duplicates++;
          } catch (error) {
            const reason = error instanceof Error && !('code' in error) ? error.message : '无法读取或保存图片';
            failures.push(`${path.basename(file)}：${reason}`);
          }
        }
        active();
        return { ok: true, added, duplicates, failures };
      }
      if (input.action === 'download') {
        if (typeof input.url !== 'string' || input.url.length > 8192) throw new Error('图片地址无效');
        let url = new URL(input.url);
        const controller = new AbortController();
        controllers.add(controller);
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
          for (let redirects = 0; redirects <= 5; redirects++) {
            active();
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
                (current.origin.startsWith('https:') && url.protocol !== 'https:')) throw new Error('图片地址不受支持');
            const response = await win.webContents.session.fetch(url.href, {
              credentials: 'omit', redirect: 'manual', signal: controller.signal,
              headers: url.origin === current.origin ? { Authorization: `Bearer ${current.token}` } : {},
            });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
              const location = response.headers.get('location');
              await response.body?.cancel();
              if (!location) throw new Error('图片重定向无效');
              url = new URL(location, url);
              continue;
            }
            if (!response.ok || !response.body) throw new Error('图片下载失败，请稍后重试');
            if (Number(response.headers.get('content-length')) > FAVORITE_IMAGE_LIMIT) {
              await response.body.cancel();
              throw new Error('单张图片不能超过 20 MiB');
            }
            const reader = response.body.getReader();
            const chunks: Buffer[] = [];
            let size = 0;
            try {
              while (true) {
                const part = await reader.read();
                active();
                if (part.done) break;
                size += part.value.byteLength;
                if (size > FAVORITE_IMAGE_LIMIT) throw new Error('单张图片不能超过 20 MiB');
                chunks.push(Buffer.from(part.value));
              }
            } finally {
              await reader.cancel().catch(() => {});
            }
            active();
            let filename = url.pathname.split('/').pop() || '表情';
            try { filename = decodeURIComponent(filename); } catch { /* keep encoded basename */ }
            const added = await store.add(current.scope, Buffer.concat(chunks), filename, active);
            return { ok: true, added: added ? 1 : 0, duplicates: added ? 0 : 1, failures: [] };
          }
          throw new Error('图片重定向次数过多');
        } finally {
          clearTimeout(timeout);
          controllers.delete(controller);
        }
      }
      throw new Error('收藏操作无效');
    } catch (error) {
      const message = error instanceof Error && !('code' in error) && error.name !== 'AbortError'
        ? error.message : '操作失败，请检查网络、图片或磁盘空间后重试';
      return { ok: false, error: message };
    }
  });
  return () => {
    reset();
    ipc.removeHandler(CHANNEL);
    ipc.removeListener('desktop-favorites-bootstrap', bootstrap);
  };
}
