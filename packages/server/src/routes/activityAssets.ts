import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { config } from '../config.js';
import { authenticate } from '../utils/auth.js';
import { getOurOrigin } from '../utils/federationAuth.js';

export const ACTIVITY_ASSET_INPUT_LIMIT = 2 * 1024 * 1024;
export const ACTIVITY_ASSET_MAX_DIMENSION = 256;

function assetPath(hash: string): string {
  return path.join(config.activityAssetDir, `${hash}.webp`);
}

function validHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export async function activityAssetRoutes(app: FastifyInstance): Promise<void> {
  fs.mkdirSync(config.activityAssetDir, { recursive: true });

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: ACTIVITY_ASSET_INPUT_LIMIT },
    (_request, body, done) => done(null, body),
  );

  app.post('/api/activity-assets', {
    preHandler: authenticate,
    config: {
      rateLimit: {
        max: 120,
        timeWindow: '1 hour',
        keyGenerator: (request: any) => request.userId || request.ip,
      },
    },
  }, async (request, reply) => {
    const input = request.body;
    if (!Buffer.isBuffer(input) || input.length === 0 || input.length > ACTIVITY_ASSET_INPUT_LIMIT) {
      return reply.code(400).send({ error: 'Invalid activity image', code: 'invalid_request', statusCode: 400 });
    }

    let normalized: Buffer;
    try {
      normalized = await sharp(input, { failOn: 'warning', limitInputPixels: 16_777_216 })
        .rotate()
        .resize(ACTIVITY_ASSET_MAX_DIMENSION, ACTIVITY_ASSET_MAX_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 82, effort: 4 })
        .toBuffer();
    } catch {
      return reply.code(400).send({ error: 'Invalid activity image', code: 'invalid_request', statusCode: 400 });
    }

    const hash = createHash('sha256').update(normalized).digest('hex');
    const target = assetPath(hash);
    if (!fs.existsSync(target)) {
      const temporary = path.join(config.activityAssetDir, `${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, normalized, { flag: 'wx' });
        try {
          fs.renameSync(temporary, target);
        } catch (error) {
          if (!fs.existsSync(target)) throw error;
        }
      } finally {
        try { fs.unlinkSync(temporary); } catch { /* already renamed */ }
      }
    }
    const now = new Date();
    try { fs.utimesSync(target, now, now); } catch { /* the immutable file is still usable */ }

    return {
      hash,
      url: `${getOurOrigin()}/api/activity-assets/${hash}.webp`,
    };
  });

  app.get<{ Params: { filename: string } }>('/api/activity-assets/:filename', async (request, reply) => {
    const match = /^([a-f0-9]{64})\.webp$/.exec(request.params.filename);
    if (!match || !validHash(match[1]!)) {
      return reply.code(404).send({ error: 'Not found', statusCode: 404 });
    }
    const file = assetPath(match[1]!);
    if (!fs.existsSync(file)) {
      return reply.code(404).send({ error: 'Not found', statusCode: 404 });
    }
    const stat = fs.statSync(file);
    reply.header('Content-Type', 'image/webp');
    reply.header('Content-Length', stat.size);
    reply.header('Cache-Control', 'public, max-age=86400, immutable');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    return reply.send(fs.createReadStream(file));
  });
}
