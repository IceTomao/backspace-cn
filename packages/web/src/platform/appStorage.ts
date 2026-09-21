import { androidCall, isAndroid, serverLocation, normalizeAndroidServer } from './android';

const values = new Map<string, string>();
let writes = Promise.resolve();
let writeFailure: unknown;
let switching = false;
export function hydrateAppStorage(data: Record<string, string>): void {
  values.clear();
  for (const [key, value] of Object.entries(data)) values.set(key, value);
}
function persist(key: string, value: string | null): void {
  if (switching) return;
  writes = writes.then(() => androidCall('storage', { key, value })).catch((error: unknown) => {
    writeFailure = error;
    window.dispatchEvent(new CustomEvent('android-storage-error'));
  });
}
export async function switchAndroidServer(value: string): Promise<void> {
  const server = normalizeAndroidServer(value);
  await flushAppStorage();
  switching = true;
  try {
    await androidCall('switchServer', { server });
    window.location.replace('/login');
  } catch (error) { switching = false; throw error; }
}
export async function flushAppStorage(): Promise<void> {
  await writes;
  if (writeFailure) { const error = writeFailure; writeFailure = undefined; throw error; }
}
// Android storage is hydrated before importing any Zustand stores. Values stay
// in JS memory; only the native Keystore-backed vault persists them on disk.
export const appStorage: Storage = {
  get length() { return isAndroid() ? values.size : localStorage.length; },
  key(index) { return isAndroid() ? [...values.keys()][index] ?? null : localStorage.key(index); },
  getItem(key) { return isAndroid() ? values.get(key) ?? null : localStorage.getItem(key); },
  setItem(key, value) {
    if (!isAndroid()) { localStorage.setItem(key, value); return; }
    values.set(key, String(value));
    persist(key, String(value));
  },
  removeItem(key) {
    if (!isAndroid()) { localStorage.removeItem(key); return; }
    values.delete(key);
    persist(key, null);
  },
  clear() {
    if (!isAndroid()) { localStorage.clear(); return; }
    for (const key of values.keys()) this.removeItem(key);
  },
};
export function profileDatabaseName(name: string): string {
  return isAndroid() ? `${name}:${serverLocation().origin}` : name;
}
