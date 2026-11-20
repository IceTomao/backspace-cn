import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }));

import {
  INSTANCE_STORE_VERSION,
  MAX_REMEMBERED_INSTANCES,
  clearInstanceUrl,
  getInstanceHistory,
  loadInstanceStore,
  loadInstanceUrl,
  parseInstanceStore,
  recordInstance,
  removeInstanceFromHistory,
} from './instanceUrl';

let directory = '';

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-instance-store-'));
  state.userData = directory;
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function writeStore(value: unknown): void {
  fs.writeFileSync(path.join(directory, 'instance-url.json'), JSON.stringify(value));
}

describe('instance store parsing', () => {
  it('migrates the legacy { url } shape into history', () => {
    const store = parseInstanceStore(JSON.stringify({ url: 'https://old.example' }));
    expect(store).toEqual({
      version: INSTANCE_STORE_VERSION,
      url: 'https://old.example',
      history: [{ url: 'https://old.example', name: null, lastConnectedAt: 0 }],
    });
  });

  it('degrades corrupt and unknown shapes to an empty store', () => {
    for (const raw of ['not json', '', 'null', '[]', '42', JSON.stringify({ version: 99, url: 'x' })]) {
      expect(parseInstanceStore(raw)).toEqual({ version: INSTANCE_STORE_VERSION, url: null, history: [] });
    }
  });

  it('sanitizes entries, de-duplicates by URL and keeps the newest five', () => {
    const history: Array<{ url: string; name: string | null; lastConnectedAt: number }> = Array.from({ length: 8 }, (_, index) => ({
      url: `https://server-${index}.example`,
      name: `Server ${index}`,
      lastConnectedAt: index,
    }));
    history.push({ url: 'https://server-7.example', name: null, lastConnectedAt: 99 });
    const store = parseInstanceStore(JSON.stringify({ version: INSTANCE_STORE_VERSION, url: null, history }));
    expect(store.history).toHaveLength(MAX_REMEMBERED_INSTANCES);
    expect(store.history[0]).toEqual({ url: 'https://server-7.example', name: null, lastConnectedAt: 99 });
    expect(new Set(store.history.map((entry) => entry.url)).size).toBe(MAX_REMEMBERED_INSTANCES);
  });

  it('drops malformed history entries instead of failing the profile', () => {
    const store = parseInstanceStore(JSON.stringify({
      version: INSTANCE_STORE_VERSION,
      url: 42,
      history: [null, {}, { url: '  ' }, { url: 'https://ok.example', name: 7, lastConnectedAt: 'soon' }],
    }));
    expect(store.url).toBeNull();
    expect(store.history).toEqual([{ url: 'https://ok.example', name: null, lastConnectedAt: 0 }]);
  });
});

describe('instance store persistence', () => {
  it('records a server, promotes it and preserves a learned name', () => {
    recordInstance('https://one.example', 'One');
    recordInstance('https://two.example', 'Two');
    recordInstance('https://one.example');
    const history = getInstanceHistory();
    expect(history.map((entry) => entry.url)).toEqual(['https://one.example', 'https://two.example']);
    expect(history[0]?.name).toBe('One');
    expect(loadInstanceUrl()).toBe('https://one.example');
  });

  it('bounds and de-duplicates what it writes', () => {
    for (let index = 0; index < 9; index++) {
      recordInstance(`https://server-${index}.example`, `Server ${index}`);
    }
    expect(getInstanceHistory()).toHaveLength(MAX_REMEMBERED_INSTANCES);
    expect(getInstanceHistory()[0]?.url).toBe('https://server-8.example');
  });

  it('keeps history when the active URL is cleared and removes single rows', () => {
    recordInstance('https://one.example', 'One');
    recordInstance('https://two.example', 'Two');
    clearInstanceUrl();
    expect(loadInstanceUrl()).toBeNull();
    expect(getInstanceHistory()).toHaveLength(2);
    removeInstanceFromHistory('https://one.example');
    expect(getInstanceHistory().map((entry) => entry.url)).toEqual(['https://two.example']);
  });

  it('treats a corrupt file as an empty profile', () => {
    fs.writeFileSync(path.join(directory, 'instance-url.json'), '{oops');
    expect(loadInstanceStore()).toEqual({ version: INSTANCE_STORE_VERSION, url: null, history: [] });
  });

  it('ignores empty and whitespace-only URLs', () => {
    recordInstance('   ');
    expect(loadInstanceStore()).toEqual({ version: INSTANCE_STORE_VERSION, url: null, history: [] });
    writeStore({ url: '  https://trim.example  ' });
    expect(loadInstanceUrl()).toBe('https://trim.example');
  });
});
