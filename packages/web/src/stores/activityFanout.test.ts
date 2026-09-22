import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock useWebSocket before importing activityStore
const mockWsSend = vi.fn();
const mockWsSendAll = vi.fn();
vi.mock('../hooks/useWebSocket', () => ({
  wsSend: (...args: unknown[]) => mockWsSend(...args),
  wsSendAll: (...args: unknown[]) => mockWsSendAll(...args),
}));

import { useActivityStore } from './activityStore';
import type { Activity } from '@backspace/shared';

const GAME_ACTIVITY: Activity = {
  type: 'playing',
  name: 'Minecraft',
  timestamps: { start: Date.now() },
};

beforeEach(() => {
  vi.clearAllMocks();
  useActivityStore.getState().reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('activityStore fan-out', () => {
  it('pushActivities caches and sends the first activity immediately', () => {
    useActivityStore.getState().pushActivities([GAME_ACTIVITY]);

    expect(useActivityStore.getState().myActivities).toEqual([GAME_ACTIVITY]);
    expect(mockWsSendAll).toHaveBeenCalledWith({ type: 'activity_update', activities: [GAME_ACTIVITY] });
  });

  it('pushActivities coalesces a rapid follow-up within the server rate limit', () => {
    useActivityStore.getState().pushActivities([GAME_ACTIVITY]);
    const updated = { ...GAME_ACTIVITY, details: 'Survival' };
    useActivityStore.getState().pushActivities([updated]);
    vi.advanceTimersByTime(3100);

    expect(mockWsSendAll).toHaveBeenLastCalledWith({
      type: 'activity_update',
      activities: [updated],
    });
    expect(mockWsSend).not.toHaveBeenCalled();
  });

  it('setShowActivity(false) fans out empty activities via wsSendAll and clears myActivities', () => {
    // First set some activities
    useActivityStore.getState().pushActivities([GAME_ACTIVITY]);
    expect(useActivityStore.getState().myActivities).toEqual([GAME_ACTIVITY]);

    // Now disable
    useActivityStore.getState().setShowActivity(false);

    expect(mockWsSendAll).toHaveBeenCalledWith({
      type: 'activity_update',
      activities: [],
    });
    expect(useActivityStore.getState().myActivities).toBeNull();
  });

  it('reset clears myActivities', () => {
    useActivityStore.getState().pushActivities([GAME_ACTIVITY]);
    expect(useActivityStore.getState().myActivities).toEqual([GAME_ACTIVITY]);

    useActivityStore.getState().reset();
    expect(useActivityStore.getState().myActivities).toBeNull();
  });

  it('pushActivities does nothing when showActivity is false', () => {
    useActivityStore.getState().setShowActivity(false);
    vi.clearAllMocks();

    useActivityStore.getState().pushActivities([GAME_ACTIVITY]);
    expect(useActivityStore.getState().myActivities).toBeNull();

    vi.advanceTimersByTime(5000);
    expect(mockWsSendAll).not.toHaveBeenCalled();
  });
});
