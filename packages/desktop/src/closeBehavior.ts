import fs from 'fs';
import path from 'path';

/**
 * What the main window does when the user asks to close it.
 *
 * `ask`   — show the minimize/quit/cancel dialog on every close.
 * `tray`  — hide to the tray, leaving the app running.
 * `quit`  — quit the app through `requestQuit()`, running `before-quit` cleanup.
 */
export type CloseBehavior = 'ask' | 'tray' | 'quit';

export const CLOSE_BEHAVIOR_FILE = 'close-behavior.json';
export const DEFAULT_CLOSE_BEHAVIOR: CloseBehavior = 'ask';

interface CloseBehaviorRecord {
  version: 1;
  behavior: CloseBehavior;
}

export function isCloseBehavior(value: unknown): value is CloseBehavior {
  return value === 'ask' || value === 'tray' || value === 'quit';
}

/** Parses the on-disk record. Missing, corrupt or unknown versions mean `ask`. */
export function parseCloseBehavior(raw: string): CloseBehavior {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_CLOSE_BEHAVIOR;
    const record = parsed as Partial<CloseBehaviorRecord>;
    if (record.version !== undefined && record.version !== 1) return DEFAULT_CLOSE_BEHAVIOR;
    return isCloseBehavior(record.behavior) ? record.behavior : DEFAULT_CLOSE_BEHAVIOR;
  } catch {
    return DEFAULT_CLOSE_BEHAVIOR;
  }
}

export function serializeCloseBehavior(behavior: CloseBehavior): string {
  return JSON.stringify({ version: 1, behavior } satisfies CloseBehaviorRecord);
}

export function getCloseBehaviorPath(userDataPath: string): string {
  return path.join(userDataPath, CLOSE_BEHAVIOR_FILE);
}

/** Reads synchronously so the window `close` handler can decide without racing `preventDefault()`. */
export function loadCloseBehavior(userDataPath: string): CloseBehavior {
  try {
    return parseCloseBehavior(fs.readFileSync(getCloseBehaviorPath(userDataPath), 'utf-8'));
  } catch {
    return DEFAULT_CLOSE_BEHAVIOR;
  }
}

/** Validates, persists and returns the effective choice. Invalid input leaves the default. */
export function saveCloseBehavior(userDataPath: string, behavior: unknown): CloseBehavior {
  const next = isCloseBehavior(behavior) ? behavior : DEFAULT_CLOSE_BEHAVIOR;
  try {
    fs.writeFileSync(getCloseBehaviorPath(userDataPath), serializeCloseBehavior(next));
  } catch {
    // A read-only userData directory must not break closing the window.
  }
  return next;
}
