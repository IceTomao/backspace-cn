import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useActivityClock } from './useActivityClock';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
it('shares one clock and suspends it while hidden', () => {
  vi.useFakeTimers();
  let hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  const first = renderHook(() => useActivityClock(true));
  const second = renderHook(() => useActivityClock(true));
  expect(vi.getTimerCount()).toBe(1);
  const before = first.result.current;
  act(() => vi.advanceTimersByTime(15_000));
  expect(first.result.current).toBeGreaterThan(before);
  expect(second.result.current).toBe(first.result.current);
  act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  expect(vi.getTimerCount()).toBe(0);
  act(() => { vi.advanceTimersByTime(60_000); hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  expect(vi.getTimerCount()).toBe(1);
  expect(first.result.current).toBe(Date.now());
});
