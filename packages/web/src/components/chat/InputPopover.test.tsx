import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useFavoriteMediaStore } from '../../stores/favoriteMediaStore';
import { useUIStore } from '../../stores/uiStore';
import { InputPopover } from './InputPopover';

const observers: Array<{ callback: ResizeObserverCallback; target: Element | null }> = [];

class TestResizeObserver {
  private entry: (typeof observers)[number];

  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, target: null };
    observers.push(this.entry);
  }

  observe(target: Element) { this.entry.target = target; }
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  cleanup();
  observers.length = 0;
  useFavoriteMediaStore.getState().reset();
  useUIStore.setState({ isMobile: false });
  vi.unstubAllGlobals();
});

it('repositions the desktop popover when async favorites increase its height', () => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  let nextFrame: FrameRequestCallback | null = null;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    nextFrame = callback;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());

  let popoverHeight = 60;
  const anchor = document.createElement('button');
  anchor.getBoundingClientRect = () => new DOMRect(380, 600, 40, 40);
  document.body.append(anchor);
  useFavoriteMediaStore.setState({ loaded: true, load: vi.fn().mockResolvedValue(undefined) });

  render(<InputPopover
    activeTab="favorites"
    onClose={vi.fn()}
    onEmojiSelect={vi.fn()}
    onGifSelect={vi.fn()}
    onFavoriteSelect={vi.fn()}
    anchorRef={{ current: anchor }}
    gifEnabled={false}
    onTabChange={vi.fn()}
  />);

  const floating = document.body.querySelector<HTMLElement>('.animate-slide-up')!;
  floating.getBoundingClientRect = () => new DOMRect(0, 0, 300, popoverHeight);
  const triggerResize = () => {
    act(() => observers.at(-1)!.callback([], {} as ResizeObserver));
    act(() => {
      nextFrame?.(0);
      nextFrame = null;
    });
  };
  triggerResize();
  expect(floating.style.top).toBe('532px');

  popoverHeight = 260;
  triggerResize();

  expect(floating.style.top).toBe('332px');
  anchor.remove();
});
