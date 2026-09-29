import { isElectron } from './platform';
import { androidCall, isAndroid, onAndroid } from './android';
import { api } from '../api/client';

export interface NotificationOptions {
  origin?: string;
  channelId?: string;
  spaceId?: string;
  userId?: string;
}

export type WebPushSetupErrorCode =
  | 'unsupported'
  | 'permissionDenied'
  | 'notConfigured'
  | 'subscriptionFailed'
  | 'registrationFailed';

export type WebPushSetupStage =
  | 'permissionRequest'
  | 'serverConfig'
  | 'serviceWorkerReady'
  | 'getSubscription'
  | 'subscribe'
  | 'serverRegistration';

export interface WebPushDiagnostic {
  stage: WebPushSetupStage;
  errorName: string;
  errorMessage?: string;
}

export class WebPushSetupError extends Error {
  constructor(
    readonly code: WebPushSetupErrorCode,
    readonly diagnostic?: WebPushDiagnostic,
  ) {
    super(code);
    this.name = 'WebPushSetupError';
  }
}

function makeWebPushError(
  code: WebPushSetupErrorCode,
  stage: WebPushSetupStage,
  cause: unknown,
): WebPushSetupError {
  const error = cause && typeof cause === 'object' ? cause as { name?: unknown; message?: unknown } : null;
  const errorName = typeof error?.name === 'string' ? error.name.slice(0, 80) : 'Error';
  const rawMessage = typeof error?.message === 'string'
    ? error.message
    : typeof cause === 'string' ? cause : '';
  const errorMessage = rawMessage
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/\b[A-Za-z0-9+/_=-]{40,}\b/g, '[redacted]')
    .slice(0, 180);
  return new WebPushSetupError(code, {
    stage,
    errorName,
    ...(errorMessage ? { errorMessage } : {}),
  });
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
  if (isElectron() || isAndroid() || !window.isSecureContext || !('Notification' in window) ||
    !('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new WebPushSetupError('unsupported');
  }
  let permission: NotificationPermission;
  try {
    permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
  } catch (error) {
    throw makeWebPushError('permissionDenied', 'permissionRequest', error);
  }
  if (permission !== 'granted') {
    throw new WebPushSetupError('permissionDenied');
  }

  let config: Awaited<ReturnType<typeof api.notifications.webPush>>;
  try {
    config = await api.notifications.webPush();
  } catch (error) {
    throw makeWebPushError('registrationFailed', 'serverConfig', error);
  }
  if (!config.enabled || !config.publicKey) throw new WebPushSetupError('notConfigured');

  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.ready;
  } catch (error) {
    throw makeWebPushError('subscriptionFailed', 'serviceWorkerReady', error);
  }

  let subscription: PushSubscription | null;
  try {
    subscription = await registration.pushManager.getSubscription();
  } catch (error) {
    throw makeWebPushError('subscriptionFailed', 'getSubscription', error);
  }
  if (!subscription) {
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey) as unknown as ArrayBuffer,
      });
    } catch (error) {
      throw makeWebPushError('subscriptionFailed', 'subscribe', error);
    }
  }

  try {
    await api.notifications.subscribeWebPush(subscription.toJSON());
  } catch (error) {
    throw makeWebPushError('registrationFailed', 'serverRegistration', error);
  }
  window.dispatchEvent(new CustomEvent('backspace-web-push-changed', { detail: true }));
  return true;
}

/** Re-register an existing browser subscription for the currently signed-in account. */
export async function syncWebPushSubscription(): Promise<boolean> {
  if (isElectron() || isAndroid() || !window.isSecureContext || !('Notification' in window) ||
    Notification.permission !== 'granted' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return false;
  }

  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.ready;
  } catch (error) {
    throw makeWebPushError('subscriptionFailed', 'serviceWorkerReady', error);
  }

  let subscription: PushSubscription | null;
  try {
    subscription = await registration.pushManager.getSubscription();
  } catch (error) {
    throw makeWebPushError('subscriptionFailed', 'getSubscription', error);
  }
  if (!subscription) return false;

  let config: Awaited<ReturnType<typeof api.notifications.webPush>>;
  try {
    config = await api.notifications.webPush();
  } catch (error) {
    throw makeWebPushError('registrationFailed', 'serverConfig', error);
  }
  if (!config.enabled || !config.publicKey) throw new WebPushSetupError('notConfigured');

  try {
    await api.notifications.subscribeWebPush(subscription.toJSON());
  } catch (error) {
    throw makeWebPushError('registrationFailed', 'serverRegistration', error);
  }
  window.dispatchEvent(new CustomEvent('backspace-web-push-changed', { detail: true }));
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
