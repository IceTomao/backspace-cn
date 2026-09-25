import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { config } from '../config.js';
import { sendError } from '../utils/httpErrors.js';

export const FAVORITE_MEDIA_LIMIT = 20 * 1024 * 1024;
export const FAVORITE_MEDIA_COUNT_LIMIT = 100;
export const FAVORITE_MEDIA_TOTAL_LIMIT = 256 * 1024 * 1024;

function detectImage(bytes: Buffer): { mime: string; ext: string } | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', ext: 'png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mime: 'image/jpeg', ext: 'jpg' };
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return { mime: 'image/gif', ext: 'gif' };
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

function safeName(name: string): string {
  const normalized = path.basename(name).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').trim();
  return (normalized || '表情').slice(0, 180);
}

function publicItem(row: typeof schema.favoriteMedia.$inferSelect) {
  return {
    id: row.id, name: row.filename, mime: row.mimetype, size: row.size,
    addedAt: row.createdAt,
  };
}

export async function favoriteMediaRoutes(app: FastifyInstance): Promise<void> {
  fs.mkdirSync(config.favoriteMediaDir, { recursive: true });

  app.get('/api/users/@me/favorite-media', { preHandler: authenticate }, async (request, reply) => {
    const rows = getDb().select().from(schema.favoriteMedia)
      .where(eq(schema.favoriteMedia.userId, request.userId))
      .orderBy(asc(schema.favoriteMedia.position), asc(schema.favoriteMedia.createdAt)).all();
    return reply.send({ items: rows.map(publicItem) });
  });

  app.post<{ Body: { name?: unknown; data?: unknown } }>('/api/users/@me/favorite-media', {
    preHandler: authenticate,
    bodyLimit: 30 * 1024 * 1024,
  }, async (request, reply) => {
    const name = typeof request.body?.name === 'string' ? safeName(request.body.name) : '表情';
    const data = typeof request.body?.data === 'string' ? request.body.data : '';
    if (!data || data.length > Math.ceil(FAVORITE_MEDIA_LIMIT * 1.4)) return sendError(reply, 413, 'favorite_media_too_large');
    let bytes: Buffer;
    try { bytes = Buffer.from(data, 'base64'); } catch { return sendError(reply, 400, 'favorite_media_invalid'); }
    if (!bytes.length || bytes.length > FAVORITE_MEDIA_LIMIT) return sendError(reply, 413, 'favorite_media_too_large');
    const detected = detectImage(bytes);
    if (!detected) return sendError(reply, 400, 'favorite_media_invalid');
    try { await sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' }).metadata(); }
    catch { return sendError(reply, 400, 'favorite_media_invalid'); }

    const db = getDb();
    const hash = createHash('sha256').update(bytes).digest('hex');
    const existing = db.select().from(schema.favoriteMedia).where(and(
      eq(schema.favoriteMedia.userId, request.userId), eq(schema.favoriteMedia.contentHash, hash),
    )).get();
    if (existing) return reply.send({ item: publicItem(existing), duplicate: true });

    const rows = db.select().from(schema.favoriteMedia).where(eq(schema.favoriteMedia.userId, request.userId)).all();
    if (rows.length >= FAVORITE_MEDIA_COUNT_LIMIT || rows.reduce((total, row) => total + row.size, 0) + bytes.length > FAVORITE_MEDIA_TOTAL_LIMIT) {
      return sendError(reply, 413, 'favorite_media_limit_reached');
    }
    const id = randomUUID();
    const storageName = `${id}.${detected.ext}`;
    const filePath = path.join(config.favoriteMediaDir, storageName);
    const tempPath = `${filePath}.tmp`;
    try {
      fs.writeFileSync(tempPath, bytes, { flag: 'wx' });
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      try { fs.unlinkSync(tempPath); } catch {}
      throw error;
    }
    const now = Date.now();
    const row = {
      id, userId: request.userId, contentHash: hash, filename: name,
      mimetype: detected.mime, size: bytes.length, storageName,
      position: rows.length ? Math.min(...rows.map((item) => item.position)) - 1 : 0,
      createdAt: now,
    };
    try { db.insert(schema.favoriteMedia).values(row).run(); }
    catch (error) {
      try { fs.unlinkSync(filePath); } catch {}
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const duplicate = db.select().from(schema.favoriteMedia).where(and(
          eq(schema.favoriteMedia.userId, request.userId), eq(schema.favoriteMedia.contentHash, hash),
        )).get();
        if (duplicate) return reply.send({ item: publicItem(duplicate), duplicate: true });
      }
      throw error;
    }
    return reply.code(201).send({ item: publicItem(row) });
  });

  app.get<{ Params: { id: string } }>('/api/users/@me/favorite-media/:id', { preHandler: authenticate }, async (request, reply) => {
    const row = getDb().select().from(schema.favoriteMedia).where(and(
      eq(schema.favoriteMedia.id, request.params.id), eq(schema.favoriteMedia.userId, request.userId),
    )).get();
    if (!row) return sendError(reply, 404, 'favorite_media_not_found');
    const filePath = path.join(config.favoriteMediaDir, row.storageName);
    if (!fs.existsSync(filePath)) return sendError(reply, 404, 'favorite_media_not_found');
    reply.header('Content-Type', row.mimetype).header('Content-Length', row.size)
      .header('Cache-Control', 'private, max-age=3600').header('X-Content-Type-Options', 'nosniff');
    return reply.send(fs.createReadStream(filePath));
  });

  app.delete<{ Params: { id: string } }>('/api/users/@me/favorite-media/:id', { preHandler: authenticate }, async (request, reply) => {
    const db = getDb();
    const row = db.select().from(schema.favoriteMedia).where(and(
      eq(schema.favoriteMedia.id, request.params.id), eq(schema.favoriteMedia.userId, request.userId),
    )).get();
    if (!row) return reply.send({ ok: true });
    db.delete(schema.favoriteMedia).where(eq(schema.favoriteMedia.id, row.id)).run();
    try { fs.unlinkSync(path.join(config.favoriteMediaDir, row.storageName)); } catch {}
    return reply.send({ ok: true });
  });
}

