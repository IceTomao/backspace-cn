import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { signJwt } from '../utils/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let app: FastifyInstance;
let tmpDir: string;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../config.js', async () => {
  const real = await import('../config.js');
  return {
    config: new Proxy(real.config, {
      get(target, prop: string) {
        if (prop === 'uploadDir') return tmpDir ?? target.uploadDir;
        return (target as Record<string, unknown>)[prop];
      },
    }),
  };
});

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  for (const file of fs.readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort()) {
    const text = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    for (const statement of text.split(/-->\s*statement-breakpoint/)) {
      if (statement.trim()) db.exec(statement);
    }
  }
}

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const tokenFor = (userId: string, username: string) => signJwt({ userId, username });

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-media-artwork-'));
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  testDb.insert(schema.users).values([
    { id: 'user-a', username: 'user_a', passwordHash: 'x', isAdmin: 0, createdAt: Date.now() },
    { id: 'user-b', username: 'user_b', passwordHash: 'x', isAdmin: 0, createdAt: Date.now() },
  ]).run();
  app = Fastify();
  const { mediaArtworkRoutes } = await import('./mediaArtwork.js');
  await app.register(mediaArtworkRoutes);
});

afterEach(async () => {
  await app.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  sqlite.close();
});

describe('temporary media artwork', () => {
  it('requires authentication and accepts bounded JPEG data', async () => {
    const denied = await app.inject({
      method: 'POST', url: '/api/media-artwork', payload: { image: jpeg.toString('base64') },
    });
    expect(denied.statusCode).toBe(401);

    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/media-artwork',
      headers: { authorization: `Bearer ${tokenFor('user-a', 'user_a')}` },
      payload: { image: jpeg.toString('base64') },
    });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json().path).toMatch(/^\/api\/media-artwork\/[0-9a-f-]{36}$/i);
    expect(uploaded.json().expiresAt).toBeGreaterThan(Date.now());
    const image = await app.inject({ method: 'GET', url: uploaded.json().path });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/jpeg');
    expect(image.rawPayload).toEqual(jpeg);
    expect(image.headers['cache-control']).toMatch(/^public, max-age=/);
  });

  it('rejects non-JPEG payloads and prevents other users deleting an artwork', async () => {
    const badImage = await app.inject({
      method: 'POST',
      url: '/api/media-artwork',
      headers: { authorization: `Bearer ${tokenFor('user-a', 'user_a')}` },
      payload: { image: Buffer.from('not an image').toString('base64') },
    });
    expect(badImage.statusCode).toBe(400);

    const oversized = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.alloc(256 * 1024),
      Buffer.from([0xff, 0xd9]),
    ]);
    const rejectedSize = await app.inject({
      method: 'POST',
      url: '/api/media-artwork',
      headers: { authorization: `Bearer ${tokenFor('user-a', 'user_a')}` },
      payload: { image: oversized.toString('base64') },
    });
    expect(rejectedSize.statusCode).toBe(400);

    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/media-artwork',
      headers: { authorization: `Bearer ${tokenFor('user-a', 'user_a')}` },
      payload: { image: jpeg.toString('base64') },
    });
    const pathValue = uploaded.json().path as string;
    const deniedDelete = await app.inject({
      method: 'DELETE',
      url: pathValue,
      headers: { authorization: `Bearer ${tokenFor('user-b', 'user_b')}` },
    });
    expect(deniedDelete.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: pathValue })).statusCode).toBe(200);
  });

  it('expires artwork and allows its owner to remove it early', async () => {
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/media-artwork',
      headers: { authorization: `Bearer ${tokenFor('user-a', 'user_a')}` },
      payload: { image: jpeg.toString('base64') },
    });
    const artworkPath = uploaded.json().path as string;
    const id = artworkPath.split('/').at(-1)!;
    const metadataPath = path.join(tmpDir, '.media-artwork', `${id}.json`);
    fs.writeFileSync(metadataPath, JSON.stringify({ userId: 'user-a', expiresAt: Date.now() - 1 }));
    expect((await app.inject({ method: 'GET', url: artworkPath })).statusCode).toBe(404);

    const second = await app.inject({
      method: 'POST',
      url: '/api/media-artwork',
      headers: { authorization: `Bearer ${tokenFor('user-a', 'user_a')}` },
      payload: { image: jpeg.toString('base64') },
    });
    const removed = await app.inject({
      method: 'DELETE',
      url: second.json().path,
      headers: { authorization: `Bearer ${tokenFor('user-a', 'user_a')}` },
    });
    expect(removed.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: second.json().path })).statusCode).toBe(404);
  });
});
