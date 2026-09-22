import { describe, expect, it, vi } from 'vitest';
import { ensureMessageJumpTarget } from './messageJump';

describe('ensureMessageJumpTarget', () => {
  it('scrolls immediately without loading when the target is already rendered', async () => {
    const tryScroll = vi.fn(() => true);
    const loadAround = vi.fn(async () => {});

    await expect(ensureMessageJumpTarget({ tryScroll, loadAround })).resolves.toBe(true);
    expect(tryScroll).toHaveBeenCalledTimes(1);
    expect(loadAround).not.toHaveBeenCalled();
  });

  it('loads messages around an uncached target before scrolling', async () => {
    const tryScroll = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const loadAround = vi.fn(async () => {});
    const afterRender = vi.fn(async () => {});

    await expect(ensureMessageJumpTarget({ tryScroll, loadAround, afterRender })).resolves.toBe(true);
    expect(loadAround).toHaveBeenCalledTimes(1);
    expect(afterRender).toHaveBeenCalledTimes(1);
    expect(tryScroll).toHaveBeenCalledTimes(2);
  });
});
