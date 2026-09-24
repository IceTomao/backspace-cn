import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { config } from '../config.js';
import { sendError } from '../utils/httpErrors.js';
import { randomUUID } from 'node:crypto';
import webpush from 'web-push';

const MAX_ENDPOINT = 4096;
let vapidConfigured = false;
if (config.webPush.publicKey && config.webPush.privateKey && config.webPush.subject) {
  webpush.setVapidDetails(config.webPush.subject, config.webPush.publicKey, config.webPush.privateKey);
  vapidConfigured = true;
}

export function isWebPushConfigured(): boolean {
  return vapidConfigured;
}

export async function notificationsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/notifications/web-push', { preHandler: authenticate }, async (_request, reply) => {
    return reply.send({ enabled: vapidConfigured, publicKey: vapidConfigured ? config.webPush.publicKey : null });
  });

  app.post<{ Body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; userAgent?: unknown } }>(
    '/api/notifications/web-push/subscribe',
    { preHandler: authenticate },
    async (request, reply) => {
      if (!vapidConfigured) return sendError(reply, 503, 'web_push_unavailable');
      const body = request.body ?? {};
      const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
      const p256dh = typeof body.keys?.p256dh === 'string' ? body.keys.p256dh : '';
      const auth = typeof body.keys?.auth === 'string' ? body.keys.auth : '';
      if (!endpoint || endpoint.length > MAX_ENDPOINT || !/^https:\/\//i.test(endpoint) || !p256dh || !auth) {
        return sendError(reply, 400, 'web_push_subscription_invalid');
      }
      const db = getDb();
      const now = Date.now();
      const existing = db.select({ id: schema.pushSubscriptions.id })
        .from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, endpoint)).get();
      if (existing) {
        db.update(schema.pushSubscriptions).set({
          userId: request.userId,
          p256dh,
          auth,
          userAgent: typeof body.userAgent === 'string' ? body.userAgent.slice(0, 512) : null,
          lastUsedAt: now,
        }).where(eq(schema.pushSubscriptions.id, existing.id)).run();
      } else {
        db.insert(schema.pushSubscriptions).values({
          id: randomUUID(), userId: request.userId, endpoint, p256dh, auth,
          userAgent: typeof body.userAgent === 'string' ? body.userAgent.slice(0, 512) : null,
          createdAt: now, lastUsedAt: now,
        }).run();
      }
      return reply.send({ ok: true });
    },
  );

  app.delete<{ Body: { endpoint?: unknown } }>('/api/notifications/web-push/subscribe', { preHandler: authenticate }, async (request, reply) => {
    const endpoint = typeof request.body?.endpoint === 'string' ? request.body.endpoint : '';
    if (!endpoint || endpoint.length > MAX_ENDPOINT) return sendError(reply, 400, 'web_push_subscription_invalid');
    getDb().delete(schema.pushSubscriptions).where(and(
      eq(schema.pushSubscriptions.userId, request.userId),
      eq(schema.pushSubscriptions.endpoint, endpoint),
    )).run();
    return reply.send({ ok: true });
  });

  app.get('/api/users/@me/channel-notifications', { preHandler: authenticate }, async (_request, reply) => {
    const rows = getDb().select({ channelId: schema.channelNotificationSettings.channelId })
      .from(schema.channelNotificationSettings)
      .where(and(eq(schema.channelNotificationSettings.userId, _request.userId), eq(schema.channelNotificationSettings.muted, true)))
      .orderBy(asc(schema.channelNotificationSettings.channelId)).all();
    return reply.send({ mutedChannelIds: rows.map((row) => row.channelId) });
  });

  app.put<{ Params: { channelId: string }; Body: { muted?: unknown } }>(
    '/api/channels/:channelId/notifications', { preHandler: authenticate }, async (request, reply) => {
      const channelId = request.params.channelId;
      if (!channelId || channelId.length > 256 || typeof request.body?.muted !== 'boolean') {
        return sendError(reply, 400, 'notification_setting_invalid');
      }
      const db = getDb();
      if (request.body.muted) {
        db.insert(schema.channelNotificationSettings).values({
          userId: request.userId, channelId, muted: true, updatedAt: Date.now(),
        }).onConflictDoUpdate({
          target: [schema.channelNotificationSettings.userId, schema.channelNotificationSettings.channelId],
          set: { muted: true, updatedAt: Date.now() },
        }).run();
      } else {
        db.delete(schema.channelNotificationSettings).where(and(
          eq(schema.channelNotificationSettings.userId, request.userId),
          eq(schema.channelNotificationSettings.channelId, channelId),
        )).run();
      }
      return reply.send({ channelId, muted: request.body.muted });
    },
  );
}

