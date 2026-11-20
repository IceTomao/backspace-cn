import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { resolveInstanceUrl } from './buildConfig';

/** A server the user connected to before, most recent first. */
export interface RememberedInstance {
  url: string;
  /** Server name reported by the picker probe, when it answered. */
  name: string | null;
  /** Epoch milliseconds; 0 for entries migrated from the pre-history shape. */
  lastConnectedAt: number;
}

export interface InstanceStore {
  version: 2;
  url: string | null;
  history: RememberedInstance[];
}

export const INSTANCE_STORE_VERSION = 2 as const;
export const MAX_REMEMBERED_INSTANCES = 5;

function emptyStore(): InstanceStore {
  return { version: INSTANCE_STORE_VERSION, url: null, history: [] };
}

function normalizeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeHistory(value: unknown): RememberedInstance[] {
  if (!Array.isArray(value)) return [];
  const entries: RememberedInstance[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const url = normalizeUrl(record.url);
    if (!url) continue;
    const lastConnectedAt = typeof record.lastConnectedAt === 'number' && Number.isFinite(record.lastConnectedAt)
      ? record.lastConnectedAt
      : 0;
    entries.push({ url, name: normalizeName(record.name), lastConnectedAt });
  }
  // Newest first, de-duplicated by URL, bounded. Sorting also repairs files
  // whose history was written out of order by an older build.
  entries.sort((a, b) => b.lastConnectedAt - a.lastConnectedAt);
  const seen = new Set<string>();
  const bounded: RememberedInstance[] = [];
  for (const entry of entries) {
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    bounded.push(entry);
    if (bounded.length === MAX_REMEMBERED_INSTANCES) break;
  }
  return bounded;
}

/**
 * Normalizes any persisted shape into the current store.
 *
 * Version 1 was `{ url }` with no history; that shape is migrated on read by
 * seeding the history with the saved URL. Corrupt JSON, wrong field types and
 * unknown versions all degrade to an empty store rather than throwing.
 */
export function parseInstanceStore(raw: string): InstanceStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyStore();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyStore();
  const record = parsed as Record<string, unknown>;
  if (record.version !== undefined && record.version !== INSTANCE_STORE_VERSION) return emptyStore();

  const history = normalizeHistory(record.history);
  const storedUrl = normalizeUrl(record.url);
  if (record.version === INSTANCE_STORE_VERSION) {
    return { version: INSTANCE_STORE_VERSION, url: storedUrl, history };
  }

  // Legacy `{ url }` shape: migrate the saved URL into the history so the
  // picker can offer it after an upgrade.
  if (storedUrl) {
    const hasSavedUrl = history.some((entry) => entry.url === storedUrl);
    return {
      version: INSTANCE_STORE_VERSION,
      url: storedUrl,
      history: hasSavedUrl ? history : [{ url: storedUrl, name: null, lastConnectedAt: 0 }, ...history]
        .slice(0, MAX_REMEMBERED_INSTANCES),
    };
  }
  return emptyStore();
}

export function serializeInstanceStore(store: InstanceStore): string {
  return JSON.stringify({
    version: INSTANCE_STORE_VERSION,
    url: store.url,
    history: store.history,
  });
}

export function getInstanceUrlPath(): string {
  return path.join(app.getPath('userData'), 'instance-url.json');
}

export function getResolvedInstanceUrl(): string | null {
  return resolveInstanceUrl(process.env.BACKSPACE_URL, loadInstanceUrl());
}

export function loadInstanceStore(): InstanceStore {
  try {
    return parseInstanceStore(fs.readFileSync(getInstanceUrlPath(), 'utf-8'));
  } catch {
    return emptyStore();
  }
}

function writeInstanceStore(store: InstanceStore): void {
  fs.writeFileSync(getInstanceUrlPath(), serializeInstanceStore(store));
}

export function loadInstanceUrl(): string | null {
  return loadInstanceStore().url;
}

/** Remembered servers, newest first. Empty when nothing has been saved. */
export function getInstanceHistory(): RememberedInstance[] {
  return loadInstanceStore().history;
}

/**
 * Records a successful connection: sets the active URL and promotes the server
 * to the front of the history, preserving a previously learned name when the
 * caller could not discover one this time.
 */
export function recordInstance(url: string, name?: string | null): void {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) return;
  const store = loadInstanceStore();
  const previous = store.history.find((entry) => entry.url === normalizedUrl);
  const entry: RememberedInstance = {
    url: normalizedUrl,
    name: normalizeName(name) ?? previous?.name ?? null,
    lastConnectedAt: Date.now(),
  };
  const history = [entry, ...store.history.filter((item) => item.url !== normalizedUrl)]
    .slice(0, MAX_REMEMBERED_INSTANCES);
  writeInstanceStore({ version: INSTANCE_STORE_VERSION, url: normalizedUrl, history });
}

/** Backwards-compatible alias for callers that only have a URL. */
export function saveInstanceUrl(url: string): void {
  recordInstance(url);
}

export function removeInstanceFromHistory(url: string): void {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) return;
  const store = loadInstanceStore();
  const history = store.history.filter((entry) => entry.url !== normalizedUrl);
  if (history.length === store.history.length) return;
  writeInstanceStore({ ...store, history });
}

/** Clears the active URL but keeps the remembered history for the picker. */
export function clearInstanceUrl(): void {
  try {
    const store = loadInstanceStore();
    writeInstanceStore({ ...store, url: null });
  } catch {
    // A missing or read-only file must not break "Change Instance".
  }
}

export function getPickerPath(): string {
  return path.join(__dirname, '..', 'resources', 'instance-picker.html');
}
