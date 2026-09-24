import { isElectron } from './platform';
import { androidCall, isAndroid, onAndroid } from './android';
import { api } from '../api/client';

export interface NotificationOptions {
  origin?: string;
  channelId?: string;
  spaceId?: string;
  userId?: string;
}

const clicks = new EventTarget();

/** One subscription per mounted controller, including older desktop bridges. */
export function onNotificationClick(callback: (options: NotificationOptions) => void): () => void {
  if (isAndroid()) return onAndroid<NotificationOptions>('notification', options => {
    callback(options);
    void androidCall('ackNotification');
  });
  const handler = (event: Event) => callback((event as CustomEvent<NotificationOptions>).detail);
  clicks.addEventListener('click', handler);
  const unsubscribe = window.backspace?.onNotificationClick?.(callback);
  return () => {
    clicks.removeEventListener('click', handler);
    unsubscribe?.();
  };
}

export function sendNotification(title: string, body: string, options?: NotificationOptions): void {
  if (isAndroid()) return;
  if (isElectron()) {
    window.backspace!.showNotification(title, body, options);
  } else if ('Notification' in window && Notification.permission === 'granted') {
    const notification = new Notification(title, { body, icon: '/icons/icon-192.png' });
    notification.onclick = () => {
      window.focus();
      notification.close();
      if (options) clicks.dispatchEvent(new CustomEvent('click', { detail: options }));
    };
  }
}

export function requestNotificationPermission(): Promise<boolean> {
  if (isAndroid()) return Promise.resolve(false);
  if (isElectron()) return Promise.resolve(true);
  if (!('Notification' in window)) return Promise.resolve(false);
  return Notification.requestPermission().then((p) => p === 'granted');
}

export function updateBadgeCount(count: number): void {
  if (isElectron()) {
    window.backspace!.setBadgeCount(count);
  }
}

export async function enableWebPush(): Promise<boolean> {
  if (isElectron() || isAndroid() || !window.isSecureContext || !('Notification' in window)) return false;
  const permission = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();
  if (permission !== 'granted') return false;
  if ('serviceWorker' in navigator && 'PushManager' in window) {
    try {
      const config = await api.notifications.webPush();
      if (config.enabled && config.publicKey) {
        const registration = await navigator.serviceWorker.ready;
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(config.publicKey) as unknown as ArrayBuffer,
          });
        }
        await api.notifications.subscribeWebPush(subscription.toJSON());
        window.dispatchEvent(new CustomEvent('backspace-web-push-changed', { detail: true }));
      }
    } catch {
      // Permission succeeded; use foreground notifications when persistent
      // Push is unavailable or the instance has no VAPID configuration.
    }
  }
  return true;
}

export async function disableWebPush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await api.notifications.unsubscribeWebPush(subscription.endpoint);
  await subscription.unsubscribe();
  window.dispatchEvent(new CustomEvent('backspace-web-push-changed', { detail: false }));
}

function urlBase64ToUint8Array(value: string): Uint8Array {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
