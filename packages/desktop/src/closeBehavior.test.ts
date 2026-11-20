import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLOSE_BEHAVIOR_FILE,
  DEFAULT_CLOSE_BEHAVIOR,
  loadCloseBehavior,
  parseCloseBehavior,
  saveCloseBehavior,
  serializeCloseBehavior,
} from './closeBehavior';

const directories: string[] = [];

function tempUserData(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-close-behavior-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  while (directories.length > 0) {
    fs.rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

describe('close behavior preference', () => {
  it('defaults to ask when no file exists', () => {
    expect(loadCloseBehavior(tempUserData())).toBe('ask');
    expect(DEFAULT_CLOSE_BEHAVIOR).toBe('ask');
  });

  it('falls back to ask for corrupt or unknown records', () => {
    expect(parseCloseBehavior('not json')).toBe('ask');
    expect(parseCloseBehavior('')).toBe('ask');
    expect(parseCloseBehavior('null')).toBe('ask');
    expect(parseCloseBehavior('[]')).toBe('ask');
    expect(parseCloseBehavior(JSON.stringify({ version: 99, behavior: 'quit' }))).toBe('ask');
    expect(parseCloseBehavior(JSON.stringify({ version: 1, behavior: 'explode' }))).toBe('ask');
  });

  it('accepts only the three valid choices', () => {
    for (const behavior of ['ask', 'tray', 'quit'] as const) {
      expect(parseCloseBehavior(JSON.stringify({ version: 1, behavior }))).toBe(behavior);
    }
  });

  it('round-trips a saved choice through disk', () => {
    const userData = tempUserData();
    expect(saveCloseBehavior(userData, 'tray')).toBe('tray');
    expect(loadCloseBehavior(userData)).toBe('tray');
    expect(fs.readFileSync(path.join(userData, CLOSE_BEHAVIOR_FILE), 'utf-8'))
      .toBe(serializeCloseBehavior('tray'));
    expect(saveCloseBehavior(userData, 'quit')).toBe('quit');
    expect(loadCloseBehavior(userData)).toBe('quit');
  });

  it('rejects invalid writes and leaves the file loadable', () => {
    const userData = tempUserData();
    expect(saveCloseBehavior(userData, 'delete-everything')).toBe('ask');
    expect(loadCloseBehavior(userData)).toBe('ask');
  });
});
