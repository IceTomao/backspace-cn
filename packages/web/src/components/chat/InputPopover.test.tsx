import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useFavoriteMediaStore } from '../../stores/favoriteMediaStore';
import { useUIStore } from '../../stores/uiStore';
import { InputPopover } from './InputPopover';
import { ContextMenuRenderer } from '../ui/ContextMenuRenderer';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import i18n from '../../i18n';

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
  useContextMenuStore.getState().close();
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

it('selects desktop favorites on left click and removes only after choosing the right-click action', async () => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    blob: () => Promise.resolve(new Blob(['image'], { type: 'image/png' })),
  }));
  const remove = vi.fn().mockResolvedValue(undefined);
  const onFavoriteSelect = vi.fn();
  const onClose = vi.fn();
  useFavoriteMediaStore.setState({
    loaded: true,
    load: vi.fn().mockResolvedValue(undefined),
    items: [
      { id: 'fav-1', name: 'first.png', mime: 'image/png', size: 5, addedAt: 1 },
      { id: 'fav-2', name: 'second.png', mime: 'image/png', size: 5, addedAt: 2 },
    ],
    urlFor: vi.fn().mockResolvedValue('blob:favorite'),
    remove,
  });

  render(<>
    <InputPopover
      activeTab="favorites"
      onClose={onClose}
      onEmojiSelect={vi.fn()}
      onGifSelect={vi.fn()}
      onFavoriteSelect={onFavoriteSelect}
      anchorRef={{ current: null }}
      gifEnabled={false}
      onTabChange={vi.fn()}
    />
    <ContextMenuRenderer />
  </>);

  const first = await screen.findByRole('img', { name: 'first.png' });
  const second = await screen.findByRole('img', { name: 'second.png' });
  const removeLabel = i18n.t('chat:favorites.remove');
  fireEvent.mouseOver(first);
  expect(screen.queryByRole('button', { name: removeLabel })).not.toBeInTheDocument();
  fireEvent.click(first);
  await waitFor(() => expect(onFavoriteSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'first.png' })));
  expect(remove).not.toHaveBeenCalled();

  fireEvent.mouseDown(first, { button: 2 });
  fireEvent.contextMenu(first, { clientX: 40, clientY: 50 });
  const floating = document.body.querySelector('.animate-slide-up')!;
  expect(floating).toHaveClass('z-[198]');
  expect(screen.getByRole('button', { name: removeLabel })).toBeVisible();
  expect(remove).not.toHaveBeenCalled();
  expect(onFavoriteSelect).toHaveBeenCalledTimes(1);

  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('button', { name: removeLabel })).not.toBeInTheDocument();
  expect(floating).toHaveClass('z-[300]');
  expect(onClose).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();

  fireEvent.contextMenu(second, { clientX: 60, clientY: 70 });
  const removeButton = screen.getByRole('button', { name: removeLabel });
  fireEvent.mouseDown(removeButton);
  fireEvent.click(removeButton);
  expect(remove).toHaveBeenCalledExactlyOnceWith('fav-2');
  expect(onFavoriteSelect).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
  expect(useContextMenuStore.getState().menu).toBeNull();
});
