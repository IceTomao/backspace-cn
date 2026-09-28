import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { AuthError, verifyJwtAndUser } from '../utils/auth.js';

const ARTWORK_TTL_MS = 60 * 60 * 1000;
const MAX_ARTWORK_BYTES = 256 * 1024;
const MAX_UPLOADS_PER_WINDOW = 12;
const UPLOAD_WINDOW_MS = 60_000;
const ID_PATTERN = /^[0-9a-f-]{36}$/i;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
const uploadCounts = new Map<string, { count: number; startsAt: number }>();

function artworkDirectory(): string {
  return path.join(config.uploadDir, '.media-artwork');
}

function removeArtwork(id: string): void {
  const directory = artworkDirectory();
  for (const suffix of ['.jpg', '.json']) {
    try { fs.unlinkSync(path.join(directory, `${id}${suffix}`)); } catch { /* already removed */ }
  }
}

function pruneExpiredArtwork(): void {
  const directory = artworkDirectory();
  if (!fs.existsSync(directory)) return;
  const now = Date.now();
  for (const name of fs.readdirSync(directory)) {
    if (name.endsWith('.json')) {
      const metadataPath = path.join(directory, name);
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { expiresAt?: unknown };
        if (typeof metadata.expiresAt !== 'number' || metadata.expiresAt <= now) {
          removeArtwork(path.basename(name, '.json'));
        }
      } catch {
        removeArtwork(path.basename(name, '.json'));
      }
    } else if (name.endsWith('.jpg') && !fs.existsSync(path.join(directory, `${name.slice(0, -4)}.json`))) {
      try { fs.unlinkSync(path.join(directory, name)); } catch { /* already removed */ }
    }
  }
  for (const [userId, entry] of uploadCounts) {
    if (now - entry.startsAt >= UPLOAD_WINDOW_MS) uploadCounts.delete(userId);
  }
}

function allowUpload(userId: string): boolean {
  const now = Date.now();
  const current = uploadCounts.get(userId);
  if (!current || now - current.startsAt >= UPLOAD_WINDOW_MS) {
    uploadCounts.set(userId, { count: 1, startsAt: now });
    return true;
  }
  if (current.count >= MAX_UPLOADS_PER_WINDOW) return false;
  current.count++;
  return true;
}

async function requestUserId(authorization: string | undefined): Promise<string> {
  if (!authorization?.startsWith('Bearer ')) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
  try {
    return (await verifyJwtAndUser(authorization.slice(7))).userId;
  } catch (error) {
    if (error instanceof AuthError) throw Object.assign(new Error(error.message), { statusCode: error.statusCode });
    throw error;
  }
}

function decodeJpeg(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_ARTWORK_BYTES * 4 / 3) + 4) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 4 || bytes.length > MAX_ARTWORK_BYTES || bytes.toString('base64') !== value) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null;
  return bytes;
}

export async function mediaArtworkRoutes(app: FastifyInstance): Promise<void> {
  fs.mkdirSync(artworkDirectory(), { recursive: true });
  pruneExpiredArtwork();
  if (!cleanupTimer) {
    cleanupTimer = setInterval(pruneExpiredArtwork, 5 * 60 * 1000);
    cleanupTimer.unref?.();
  }

  app.post<{ Body: { image?: unknown } }>('/api/media-artwork', {
    bodyLimit: 360 * 1024,
  }, async (request, reply) => {
    let userId: string;
    try { userId = await requestUserId(request.headers.authorization); }
    catch (error) {
      return reply.code((error as { statusCode?: number }).statusCode ?? 401).send({ error: 'Unauthorized' });
    }

    if (!allowUpload(userId)) return reply.code(429).send({ error: 'Artwork upload rate limit exceeded' });
    const image = decodeJpeg(request.body?.image);
    if (!image) return reply.code(400).send({ error: 'Invalid JPEG artwork' });

    const id = randomUUID();
    const expiresAt = Date.now() + ARTWORK_TTL_MS;
    const directory = artworkDirectory();
    try {
      fs.writeFileSync(path.join(directory, `${id}.jpg`), image, { flag: 'wx' });
      fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ userId, expiresAt }), { flag: 'wx' });
    } catch (error) {
      removeArtwork(id);
      throw error;
    }
    return reply.send({ path: `/api/media-artwork/${id}`, expiresAt });
  });

  app.delete<{ Params: { id: string } }>('/api/media-artwork/:id', async (request, reply) => {
    let userId: string;
    try { userId = await requestUserId(request.headers.authorization); }
    catch (error) {
      return reply.code((error as { statusCode?: number }).statusCode ?? 401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params;
    if (!ID_PATTERN.test(id)) return reply.code(404).send({ error: 'Not found' });
    const metadataPath = path.join(artworkDirectory(), `${id}.json`);
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { userId?: unknown };
      if (metadata.userId !== userId) return reply.code(404).send({ error: 'Not found' });
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }
    removeArtwork(id);
    return reply.send({ success: true });
  });

  app.get<{ Params: { id: string } }>('/api/media-artwork/:id', async (request, reply) => {
    const { id } = request.params;
    if (!ID_PATTERN.test(id)) return reply.code(404).send({ error: 'Not found' });
    const directory = artworkDirectory();
    const imagePath = path.join(directory, `${id}.jpg`);
    const metadataPath = path.join(directory, `${id}.json`);
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { expiresAt?: unknown };
      if (typeof metadata.expiresAt !== 'number' || metadata.expiresAt <= Date.now()) {
        removeArtwork(id);
        return reply.code(404).send({ error: 'Not found' });
      }
      const stat = fs.statSync(imagePath);
      reply.header('Cache-Control', `public, max-age=${Math.max(0, Math.floor((metadata.expiresAt - Date.now()) / 1000))}`);
      reply.header('Content-Type', 'image/jpeg');
      reply.header('Content-Length', stat.size);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
      return reply.send(fs.createReadStream(imagePath));
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }
  });
}
