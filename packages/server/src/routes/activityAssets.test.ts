import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ directory: '' }));

vi.mock('../config.js', () => ({
  config: {
    get activityAssetDir() { return state.directory; },
    activityAssetTtlMs: 72 * 60 * 60 * 1000,
    activityAssetMaxBytes: 512 * 1024 * 1024,
  },
}));
vi.mock('../utils/auth.js', () => ({
  authenticate: async (request: { headers: Record<string, unknown>; userId?: string }, reply: any) => {
    if (request.headers.authorization !== 'Bearer valid') return reply.code(401).send({ error: 'Unauthorized' });
    request.userId = 'user-1';
  },
}));
vi.mock('../utils/federationAuth.js', () => ({ getOurOrigin: () => 'https://chat.example' }));

import { activityAssetRoutes } from './activityAssets.js';

let app: FastifyInstance;

beforeEach(async () => {
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-activity-assets-'));
  app = Fastify();
  await app.register(activityAssetRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  fs.rmSync(state.directory, { recursive: true, force: true });
});

describe('activity asset routes', () => {
  it('normalizes, hashes, serves, and deduplicates authenticated images', async () => {
    const png = await sharp({
      create: { width: 400, height: 200, channels: 4, background: '#ff3366' },
    }).png().toBuffer();
    const upload = () => app.inject({
      method: 'POST', url: '/api/activity-assets', payload: png,
      headers: { authorization: 'Bearer valid', 'content-type': 'application/octet-stream' },
    });
    const first = await upload();
    const second = await upload();
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(first.json().url).toMatch(/^https:\/\/chat\.example\/api\/activity-assets\/[a-f0-9]{64}\.webp$/);
    expect(fs.readdirSync(state.directory)).toHaveLength(1);

    const image = await app.inject({ method: 'GET', url: new URL(first.json().url).pathname });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/webp');
    const metadata = await sharp(image.rawPayload).metadata();
    expect(metadata.width).toBeLessThanOrEqual(256);
    expect(metadata.height).toBeLessThanOrEqual(256);
  });

  it('rejects unauthenticated and invalid payloads', async () => {
    const unauthorized = await app.inject({
      method: 'POST', url: '/api/activity-assets', payload: Buffer.from('x'),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(unauthorized.statusCode).toBe(401);
    const invalid = await app.inject({
      method: 'POST', url: '/api/activity-assets', payload: Buffer.from('not an image'),
      headers: { authorization: 'Bearer valid', 'content-type': 'application/octet-stream' },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
