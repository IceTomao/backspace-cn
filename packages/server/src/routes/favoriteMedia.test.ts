import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import * as schema from '../db/schema.js';
import { signJwt } from '../utils/auth.js';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let favoriteDir: string;
let app: FastifyInstance;
let imageBytes: Buffer;

vi.mock('../db/index.js', () => ({ getDb: () => testDb, schema }));
vi.mock('../config.js', async (importActual) => {
  const { config } = await importActual<typeof import('../config.js')>();
  return {
    config: new Proxy(config, {
      get(target, prop: string) {
        if (prop === 'favoriteMediaDir') return favoriteDir;
        return target[prop as keyof typeof target];
      },
    }),
  };
});

function token(userId: string): string {
  return signJwt({ userId, username: userId });
}

function add(userId: string) {
  return app.inject({
    method: 'POST', url: '/api/users/@me/favorite-media',
    headers: { authorization: `Bearer ${token(userId)}` },
    payload: { name: 'same.png', data: imageBytes.toString('base64') },
  });
}

function read(userId: string, id: string) {
  return app.inject({
    method: 'GET', url: `/api/users/@me/favorite-media/${id}`,
    headers: { authorization: `Bearer ${token(userId)}` },
  });
}

function remove(userId: string, id: string) {
  return app.inject({
    method: 'DELETE', url: `/api/users/@me/favorite-media/${id}`,
    headers: { authorization: `Bearer ${token(userId)}` },
  });
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  for (const file of fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
    for (const statement of fs.readFileSync(path.join(migrationsDir, file), 'utf8').split(/-->\s*statement-breakpoint/)) {
      if (statement.trim()) sqlite.exec(statement.trim());
    }
  }
  testDb = drizzle(sqlite, { schema });
  for (const id of ['user-1', 'user-2']) {
    testDb.insert(schema.users).values({ id, username: id, passwordHash: 'x', createdAt: Date.now() }).run();
  }
  favoriteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-favorites-'));
  imageBytes = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ff0000' } }).png().toBuffer();
  app = Fastify();
  const { favoriteMediaRoutes } = await import('./favoriteMedia.js');
  await app.register(favoriteMediaRoutes);
  await app.ready();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  sqlite?.close();
  if (favoriteDir) fs.rmSync(favoriteDir, { recursive: true, force: true });
});

describe('favorite media storage', () => {
  it('returns the existing item when the same user adds the same image twice', async () => {
    const first = await add('user-1');
    const second = await add('user-1');
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ item: first.json().item, duplicate: true });
    expect(fs.readdirSync(favoriteDir)).toHaveLength(1);
  });

  it("stores identical images independently for two users and deletes only the owner's file", async () => {
    const first = await add('user-1');
    const second = await add('user-2');
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const firstId = first.json().item.id as string;
    const secondId = second.json().item.id as string;
    expect(firstId).not.toBe(secondId);
    expect(fs.readdirSync(favoriteDir)).toHaveLength(2);
    expect((await read('user-1', firstId)).rawPayload).toEqual(imageBytes);
    expect((await read('user-2', secondId)).rawPayload).toEqual(imageBytes);
    expect((await read('user-1', secondId)).statusCode).toBe(404);

    expect((await remove('user-1', firstId)).statusCode).toBe(200);
    expect((await read('user-2', secondId)).rawPayload).toEqual(imageBytes);
    expect(fs.readdirSync(favoriteDir)).toHaveLength(1);
    expect((await remove('user-2', secondId)).statusCode).toBe(200);
    expect(fs.readdirSync(favoriteDir)).toHaveLength(0);
  });

  it('keeps existing hash-based IDs and files readable when another user adds the image', async () => {
    const hash = createHash('sha256').update(imageBytes).digest('hex');
    const storageName = `${hash}.png`;
    fs.writeFileSync(path.join(favoriteDir, storageName), imageBytes);
    testDb.insert(schema.favoriteMedia).values({
      id: hash, userId: 'user-1', contentHash: hash, filename: 'old.png',
      mimetype: 'image/png', size: imageBytes.length, storageName, createdAt: Date.now(),
    }).run();

    expect((await add('user-1')).json()).toMatchObject({ item: { id: hash }, duplicate: true });
    const second = await add('user-2');
    expect(second.statusCode).toBe(201);
    expect((await read('user-1', hash)).rawPayload).toEqual(imageBytes);
    expect((await read('user-2', second.json().item.id)).rawPayload).toEqual(imageBytes);
    await remove('user-2', second.json().item.id);
    expect((await read('user-1', hash)).rawPayload).toEqual(imageBytes);
    await remove('user-1', hash);
    expect(fs.readdirSync(favoriteDir)).toHaveLength(0);
  });

  it('cleans only the failed upload when the database insert fails', async () => {
    const first = await add('user-1');
    const firstId = first.json().item.id as string;
    sqlite.exec(`CREATE TRIGGER reject_second_favorite BEFORE INSERT ON favorite_media
      WHEN NEW.user_id = 'user-2' BEGIN SELECT RAISE(ABORT, 'forced failure'); END`);

    const second = await add('user-2');
    expect(second.statusCode).toBe(500);
    expect(fs.readdirSync(favoriteDir)).toHaveLength(1);
    expect((await read('user-1', firstId)).rawPayload).toEqual(imageBytes);
  });

  it('returns the winning item when a same-user insert races with this request', async () => {
    const insert = testDb.insert.bind(testDb);
    vi.spyOn(testDb, 'insert').mockImplementation((() => ({
      values: (row: typeof schema.favoriteMedia.$inferInsert) => ({
        run: () => {
          const storageName = 'winner.png';
          fs.writeFileSync(path.join(favoriteDir, storageName), imageBytes);
          insert(schema.favoriteMedia).values({ ...row, id: 'winner', storageName }).run();
          throw Object.assign(new Error('concurrent insert'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
        },
      }),
    })) as unknown as typeof testDb.insert);

    const response = await add('user-1');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ item: { id: 'winner' }, duplicate: true });
    expect(fs.readdirSync(favoriteDir)).toEqual(['winner.png']);
    expect((await read('user-1', 'winner')).rawPayload).toEqual(imageBytes);
  });
});
