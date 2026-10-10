import { readFileSync, statSync } from 'node:fs';
import type { VoiceServiceState } from '@backspace/shared';
import { config } from '../config.js';

export function parseVoiceServiceState(value: unknown, now = Date.now()): VoiceServiceState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Record<string, unknown>;
  if (typeof state.generation !== 'string' || !/^[a-f0-9]{32}$/.test(state.generation)
    || !['ready', 'recovering', 'failed'].includes(String(state.status))
    || typeof state.updatedAt !== 'number' || !Number.isSafeInteger(state.updatedAt) || state.updatedAt > now + 30_000
    || now - state.updatedAt > 120_000
    || typeof state.startedAt !== 'number' || !Number.isSafeInteger(state.startedAt)
    || typeof state.deadlineAt !== 'number' || !Number.isSafeInteger(state.deadlineAt)
    || state.startedAt < 0 || state.startedAt > now + 30_000
    || state.deadlineAt < state.startedAt || state.deadlineAt - state.startedAt > 600_000) return null;
  return {
    generation: state.generation,
    status: state.status === 'recovering' && state.deadlineAt <= now ? 'failed' : state.status as VoiceServiceState['status'],
    startedAt: state.startedAt,
    deadlineAt: state.deadlineAt,
  };
}

export function readVoiceServiceState(): VoiceServiceState | null {
  const path = config.livekit?.recoveryStatePath;
  if (!path) return null;
  try {
    if (statSync(path).size > 4096) return null;
    return parseVoiceServiceState(JSON.parse(readFileSync(path, 'utf8')));
  } catch { return null; }
}

export function voiceRecoveryDeadline(): number {
  const state = readVoiceServiceState();
  return state?.status === 'recovering' ? state.deadlineAt : 0;
}
