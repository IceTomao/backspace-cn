import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceReconnectController } from './voiceReconnectController';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('voice recovery scheduling', () => {
  it('retries successive failures and stops after success', async () => {
    const attempt = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    const controller = new VoiceReconnectController(() => true, attempt, () => true);
    controller.retain('room');
    controller.schedule(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempt).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).toHaveBeenCalledTimes(3);
    controller.cancel();
  });
  it('does not retry a channel the user left', async () => {
    const attempt = vi.fn().mockResolvedValue(false);
    let owns = true;
    const controller = new VoiceReconnectController(() => owns, attempt, () => true);
    controller.retain('old');
    controller.schedule();
    owns = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).not.toHaveBeenCalled();
  });
  it('cancels a pending failure without reviving an old retry', async () => {
    let finish!: (success: boolean) => void;
    const attempt = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const controller = new VoiceReconnectController(() => true, attempt, () => true);
    controller.retain('room');
    controller.schedule(0);
    await vi.advanceTimersByTimeAsync(0);
    controller.schedule(0);
    expect(attempt).toHaveBeenCalledTimes(1);
    controller.cancel();
    finish(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
  it('waits offline and wakes without accumulating timers', async () => {
    let online = false;
    const attempt = vi.fn().mockResolvedValue(true);
    const controller = new VoiceReconnectController(() => true, attempt, () => online);
    controller.retain('room');
    controller.schedule(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(attempt).not.toHaveBeenCalled();
    online = true;
    controller.schedule(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toHaveBeenCalledTimes(1);
    controller.cancel();
  });
  it('remembers service readiness during a pending attempt without overlapping retries', async () => {
    let finish!: (success: boolean) => void;
    const attempt = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }))
      .mockResolvedValue(true);
    const controller = new VoiceReconnectController(() => true, attempt, () => true);
    controller.retain('room');
    controller.schedule(0);
    await vi.advanceTimersByTimeAsync(0);
    controller.schedule(0);
    expect(attempt).toHaveBeenCalledTimes(1);
    finish(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(2);
    controller.cancel();
  });
  it('gives SDK reconnect 30 seconds and cancels the watchdog on success', async () => {
    const attempt = vi.fn().mockResolvedValue(true);
    const controller = new VoiceReconnectController(() => true, attempt, () => true);
    controller.retain('room');
    controller.sdkReconnecting();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(attempt).not.toHaveBeenCalled();
    controller.retain('room');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(attempt).not.toHaveBeenCalled();
    controller.sdkReconnecting();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(attempt).toHaveBeenCalledTimes(1);
    controller.cancel();
  });
});
