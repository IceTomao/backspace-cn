import { describe, expect, it, vi } from 'vitest';
vi.mock('../config.js', () => ({ config: { livekit: {} } }));
import { parseVoiceServiceState } from './voiceRecovery.js';

const now = 1_000_000;
const recovery = {
  generation: 'a'.repeat(32), status: 'recovering',
  startedAt: now - 60_000, deadlineAt: now + 540_000, updatedAt: now,
  adoptedIP: '183.23.161.151', restarts: [now],
};

describe('voice service recovery state', () => {
  it('returns only the public fields', () => {
    expect(parseVoiceServiceState(recovery, now)).toEqual({
      generation: recovery.generation, status: 'recovering',
      startedAt: recovery.startedAt, deadlineAt: recovery.deadlineAt,
    });
  });
  it('expires recovery without extending the outage', () => {
    expect(parseVoiceServiceState({ ...recovery, updatedAt: recovery.deadlineAt }, recovery.deadlineAt)?.status).toBe('failed');
  });
  it.each([
    { updatedAt: now - 120_001 }, { updatedAt: now + 30_001 },
    { deadlineAt: now + 600_000 }, { startedAt: -1 },
    { generation: 'invalid' }, { status: 'unknown' }, { updatedAt: NaN },
  ])('ignores stale or invalid state %j', patch => {
    expect(parseVoiceServiceState({ ...recovery, ...patch }, now)).toBeNull();
  });
  it('accepts initial ready state with no outage deadline', () => {
    expect(parseVoiceServiceState({ ...recovery, status: 'ready', startedAt: 0, deadlineAt: 0 }, now)?.status).toBe('ready');
  });
});
