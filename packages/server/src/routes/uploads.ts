import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { sendError } from '../utils/httpErrors.js';
import { getDb, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import { Readable } from 'node:stream';
import { attachmentMimeType } from '@backspace/shared/src/media.js';
import { parseByteRange } from '../utils/httpRange.js';

const EXT_MIMETYPES: Record<string, string> = {
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.avif': 'image/avif', '.tiff': 'image/tiff', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.flac': 'audio/flac', '.aac': 'audio/aac', '.opus': 'audio/opus',
  '.pdf': 'application/pdf',
};

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  // Ensure upload directory exists
  if (!fs.existsSync(config.uploadDir)) {
    fs.mkdirSync(config.uploadDir, { recursive: true });
  }

  // GET /api/uploads/:filename - Serve uploaded file
  app.get<{ Params: { filename: string } }>('/api/uploads/:filename', async (request, reply) => {
    const { filename } = request.params;

    // Prevent directory traversal
    const safeName = path.basename(filename);
    const filepath = path.join(config.uploadDir, safeName);

    if (!fs.existsSync(filepath)) {
      return sendError(reply, 404, 'file_not_found');
    }

    // Get mimetype from DB, falling back to extension-based lookup for thumbnails/orphans
    const db = getDb();
    const attachment = db.select().from(schema.attachments).where(eq(schema.attachments.filename, safeName)).get();
    const originalName = attachment?.originalName ?? safeName;
    const mimetype = attachmentMimeType(attachment?.mimetype
      ?? EXT_MIMETYPES[path.extname(safeName).toLowerCase()]
      ?? 'application/octet-stream', originalName, safeName);

    // Set caching and security headers
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header('Content-Type', mimetype);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'");
    reply.header('X-Frame-Options', 'DENY');

    // For non-media files and SVGs, force download instead of inline rendering
    const isSvg = mimetype === 'image/svg+xml';
    if (isSvg || (!mimetype.startsWith('image/') && !mimetype.startsWith('video/') && !mimetype.startsWith('audio/'))) {
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(originalName)}"`);
    }

    // Support Range requests for audio/video seeking
    const stat = fs.statSync(filepath);
    const fileSize = stat.size;
    reply.header('Accept-Ranges', 'bytes');
    // HEAD describes the complete representation without opening a file stream.
    if (request.method === 'HEAD') return reply.header('Content-Length', fileSize).send(Readable.from([]));
    const range = parseByteRange(request.headers.range, fileSize);
    if (range === 'unsatisfiable') {
      return reply.code(416).header('Content-Range', `bytes */${fileSize}`).header('Content-Length', 0).send();
    }
    if (range) {
      const { start, end } = range;
      const chunkSize = end - start + 1;

      reply.header('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Content-Length', chunkSize);
      reply.code(206);

      const stream = fs.createReadStream(filepath, { start, end });
      return reply.send(stream);
    }

    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Length', fileSize);
    const stream = fs.createReadStream(filepath);
    return reply.send(stream);
  });
}
