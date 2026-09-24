import { and, eq, inArray } from 'drizzle-orm';
import webpush from 'web-push';
import { getDb, schema } from '../db/index.js';
import { config } from '../config.js';

export interface WebPushMessage {
  id: string;
  title: string;
  body: string;
  channelId: string;
  spaceId?: string | null;
}

export function sendWebPushToUsers(userIds: string[], message: WebPushMessage): void {
  if (!config.webPush.publicKey || !config.webPush.privateKey || !config.webPush.subject) return;
  const recipients = [...new Set(userIds)].filter(Boolean);
  if (recipients.length === 0) return;
  const db = getDb();
  const muted = db.select({ userId: schema.channelNotificationSettings.userId })
    .from(schema.channelNotificationSettings)
    .where(and(
      inArray(schema.channelNotificationSettings.userId, recipients),
      eq(schema.channelNotificationSettings.channelId, message.channelId),
      eq(schema.channelNotificationSettings.muted, true),
    )).all();
  const mutedUsers = new Set(muted.map((row) => row.userId));
  const subscriptions = db.select().from(schema.pushSubscriptions)
    .where(inArray(schema.pushSubscriptions.userId, recipients)).all();
  const payload = JSON.stringify({
    id: message.id,
    title: message.title,
    body: message.body,
    channelId: message.channelId,
    spaceId: message.spaceId ?? null,
    url: `/channels/${encodeURIComponent(message.spaceId || '@me')}/${encodeURIComponent(message.channelId)}`,
  });
  for (const subscription of subscriptions) {
    if (mutedUsers.has(subscription.userId)) continue;
    void webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload)
      .then(() => {
        db.update(schema.pushSubscriptions).set({ lastUsedAt: Date.now() })
          .where(eq(schema.pushSubscriptions.id, subscription.id)).run();
      })
      .catch((error: unknown) => {
        const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
          ? Number((error as { statusCode?: unknown }).statusCode) : 0;
        if (statusCode === 404 || statusCode === 410) {
          db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, subscription.id)).run();
        }
      });
  }
}
