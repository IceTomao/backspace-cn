import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uploadRoutes } from './uploads.js';
import { parseByteRange } from '../utils/httpRange.js';
import { attachmentMimeType } from '@backspace/shared/src/media.js';

let directory: string;
let app: FastifyInstance;
let record: { mimetype: string; originalName: string } | undefined;
vi.mock('../config.js', () => ({ config: { get uploadDir() { return directory; } } }));
vi.mock('../db/index.js', async () => ({
  schema: await import('../db/schema.js'),
  getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ get: () => record }) }) }) }),
}));
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-video-range-'));
  fs.writeFileSync(path.join(directory, 'clip.mp4'), '0123456789');
  fs.writeFileSync(path.join(directory, 'empty.mp4'), '');
  record = undefined;
  app = Fastify();
  await app.register(uploadRoutes);
});
afterEach(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });

describe('video attachment delivery', () => {
  it.each([
    ['bytes=2-4', '234', 'bytes 2-4/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=-999999999999999999999', '0123456789', 'bytes 0-9/10'],
    ['bytes=8-999999999999999999999', '89', 'bytes 8-9/10'],
  ])('streams the requested byte range %s', async (range, body, contentRange) => {
    const response = await app.inject({ url: '/api/uploads/clip.mp4', headers: { range } });
    expect(response.statusCode).toBe(206);
    expect(response.body).toBe(body);
    expect(response.headers['content-range']).toBe(contentRange);
    expect(Number(response.headers['content-length'])).toBe(body.length);
    expect(response.headers['content-type']).toBe('video/mp4');
  });
  it.each(['bytes=10-', 'bytes=3-2', 'bytes=-0', 'bytes=-', 'bytes=x-y', 'bytes=1.5-4'])('rejects invalid or unsatisfiable ranges %s', async range => {
    const response = await app.inject({ url: '/api/uploads/clip.mp4', headers: { range } });
    expect(response.statusCode).toBe(416);
    expect(response.headers['content-range']).toBe('bytes */10');
    expect(response.body).toBe('');
  });
  it.each(['items=1-2', 'bytes=0-1,4-5', undefined])('serves the full file when a supported single range is absent', async range => {
    const response = await app.inject({ url: '/api/uploads/clip.mp4', headers: range ? { range } : {} });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('0123456789');
    expect(response.headers['content-range']).toBeUndefined();
  });
  it('supports HEAD without a body and handles empty files and missing files', async () => {
    const head = await app.inject({ method: 'HEAD', url: '/api/uploads/clip.mp4', headers: { range: 'bytes=2-4' } });
    expect(head.statusCode).toBe(200); expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe('10');
    const empty = await app.inject('/api/uploads/empty.mp4');
    expect(empty.statusCode).toBe(200); expect(empty.body).toBe('');
    const range = await app.inject({ url: '/api/uploads/empty.mp4', headers: { range: 'bytes=0-' } });
    expect(range.statusCode).toBe(416); expect(range.headers['content-range']).toBe('bytes */0');
    expect((await app.inject('/api/uploads/missing.mp4')).statusCode).toBe(404);
  });
  it('corrects old generic MIME types without changing explicit non-video types or download security', async () => {
    record = { mimetype: 'application/octet-stream', originalName: 'Camera.MP4' };
    const media = await app.inject('/api/uploads/clip.mp4');
    expect(media.headers['content-type']).toBe('video/mp4');
    expect(media.headers['content-disposition']).toBeUndefined();
    expect(media.headers['x-content-type-options']).toBe('nosniff');
    record = { mimetype: 'application/pdf', originalName: 'document.mp4' };
    const document = await app.inject('/api/uploads/clip.mp4');
    expect(document.headers['content-type']).toBe('application/pdf');
    expect(document.headers['content-disposition']).toContain('attachment;');
  });
  it('recognizes video extensions only for missing or generic MIME types', () => {
    expect(attachmentMimeType(undefined, 'Clip.M4V')).toBe('video/mp4');
    expect(attachmentMimeType('binary/octet-stream', 'clip.WEBM')).toBe('video/webm');
    expect(attachmentMimeType('', 'clip', 'https://peer.example/api/uploads/clip.mov?x=1')).toBe('video/quicktime');
    expect(attachmentMimeType('Video/MP4; codecs=avc1', 'clip')).toBe('video/mp4');
    expect(attachmentMimeType('application/pdf', 'clip.mp4')).toBe('application/pdf');
    expect(parseByteRange('bytes=999999999999999999999-', 10)).toBe('unsatisfiable');
  });
});
