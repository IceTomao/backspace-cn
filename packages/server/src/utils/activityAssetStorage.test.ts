import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ directory: '', ttl: 1000, max: 10 }));
vi.mock('../config.js', () => ({ config: {
  get activityAssetDir() { return state.directory; },
  get activityAssetTtlMs() { return state.ttl; },
  get activityAssetMaxBytes() { return state.max; },
} }));

import { cleanupActivityAssets } from './activityAssetStorage.js';

const now = 10_000;
const name = (char: string) => `${char.repeat(64)}.webp`;

beforeEach(() => { state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-asset-cleanup-')); });
afterEach(() => fs.rmSync(state.directory, { recursive: true, force: true }));

function write(file: string, size: number, modifiedAt: number): void {
  const full = path.join(state.directory, file);
  fs.writeFileSync(full, Buffer.alloc(size));
  fs.utimesSync(full, new Date(modifiedAt), new Date(modifiedAt));
}

describe('cleanupActivityAssets', () => {
  it('deletes expired files and enforces the capacity oldest-first', () => {
    state.ttl = 5_000;
    state.max = 8;
    write(name('a'), 4, 1_000); // expired
    write(name('b'), 6, 8_000); // oldest retained, removed for capacity
    write(name('c'), 6, 9_000); // newest retained
    fs.writeFileSync(path.join(state.directory, 'unrelated.tmp'), 'keep');
    expect(cleanupActivityAssets(now)).toEqual({ deletedFiles: 2, freedBytes: 10, remainingBytes: 6 });
    expect(fs.readdirSync(state.directory).sort()).toEqual([name('c'), 'unrelated.tmp'].sort());
  });
});
