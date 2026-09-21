import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export const DEFAULT_ANDROID_SERVER = 'https://chat.kevz.me:2096';
export type AndroidTheme = 'system' | 'light' | 'dark';
export interface AndroidPreferences {
  theme: AndroidTheme;
  dark: boolean;
  background: boolean;
  server: string;
}
export interface NativeVoiceState {
  channelId: string | null;
  origin: string;
  isDm: boolean;
  ringing?: boolean;
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  muted: boolean;
  deafened: boolean;
  error: string | null;
  participants: { identity: string; name: string; local: boolean; muted: boolean; speaking: boolean }[];
  devices: { id: string; name: string }[];
  deviceId: string | null;
}
interface NativeBridge {
  execute(options: { action: string; data: Record<string, unknown> }): Promise<unknown>;
  addListener(event: string, callback: (data: any) => void): Promise<PluginListenerHandle>;
}
const bridge = registerPlugin<NativeBridge>('BackspaceNative');
export function isAndroid(): boolean {
  return import.meta.env.MODE === 'android' && Capacitor.getPlatform() === 'android';
}
export async function androidCall<T = void>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  return await bridge.execute({ action, data }) as T;
}
export function onAndroid<T>(event: string, callback: (data: T) => void): () => void {
  let removed = false;
  let handle: PluginListenerHandle | undefined;
  void bridge.addListener(event, callback).then((value) => {
    if (removed) void value.remove();
    else handle = value;
  });
  return () => { removed = true; void handle?.remove(); };
}
let server = DEFAULT_ANDROID_SERVER;
export function setAndroidServer(value: string): void { server = normalizeAndroidServer(value); }
export function normalizeAndroidServer(value: string): string {
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('请输入 HTTPS 服务器地址，不包含账号、路径或参数。');
  }
  return url.origin;
}
export function serverLocation(): Pick<Location, 'origin' | 'host' | 'hostname' | 'protocol'> {
  return isAndroid() ? new URL(server) : window.location;
}
export function serverUrl(value: string): string {
  if (!isAndroid() || !value.startsWith('/')) return value;
  return new URL(value, server).href;
}
