/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision?: string }>;
};

precacheAndRoute(self.__WB_MANIFEST);
registerRoute(new NavigationRoute(({ request }) => caches.match('/index.html').then((response) => response || fetch(request)), {
  denylist: [/^\/api/, /^\/ws/, /^\/uploads/],
}));
clientsClaim();
self.skipWaiting();

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data: { id?: string; title?: string; body?: string; channelId?: string; spaceId?: string | null; url?: string };
  try { data = event.data.json(); } catch { data = { body: event.data.text() }; }
  const title = data.title || 'Backspace';
  const body = data.body || '你有一条新消息';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: data.id ? `message-${data.id}` : 'backspace-message',
    data: { url: data.url || '/', channelId: data.channelId, spaceId: data.spaceId, eventId: data.id },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = typeof event.notification.data?.url === 'string' ? event.notification.data.url : '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client && target) await client.navigate(target);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
