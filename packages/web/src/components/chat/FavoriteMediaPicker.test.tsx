import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useFavoriteMediaStore } from '../../stores/favoriteMediaStore';
import { FavoriteMediaPicker } from './FavoriteMediaPicker';
import i18n from '../../i18n';
import { ContextMenuRenderer } from '../ui/ContextMenuRenderer';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { useUIStore } from '../../stores/uiStore';

afterEach(() => {
  vi.unstubAllGlobals();
  useFavoriteMediaStore.getState().reset();
  useContextMenuStore.getState().close();
  useUIStore.setState({ isMobile: false });
  vi.useRealTimers();
});

it('sends on tap and only exposes removal after a mobile long press', async () => {
  const load = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue(undefined);
  const onSelect = vi.fn();
  const blob = new Blob(['image'], { type: 'image/png' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ blob: () => Promise.resolve(blob) }));
  useFavoriteMediaStore.setState({
    items: [{ id: 'fav-1', name: 'sticker.png', mime: 'image/png', size: 5, addedAt: 1 }],
    loaded: true,
    load,
    remove,
    urlFor: vi.fn().mockResolvedValue('blob:favorite'),
  });

  useUIStore.setState({ isMobile: true });
  render(<><FavoriteMediaPicker mobile onSelect={onSelect} /><ContextMenuRenderer /></>);
  expect(load).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: i18n.t('chat:favorites.remove') })).not.toBeInTheDocument();

  const image = await screen.findByRole('img', { name: 'sticker.png' });
  fireEvent.click(image.closest('button')!);
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'sticker.png', type: 'image/png' })));

  vi.useFakeTimers();
  fireEvent.touchStart(image, { touches: [{ clientX: 40, clientY: 50 }] });
  act(() => vi.advanceTimersByTime(500));
  expect(useContextMenuStore.getState().menu?.items[0]).toMatchObject({ key: 'remove-favorite' });
  fireEvent.touchEnd(image);
  fireEvent.click(image.closest('button')!);
  expect(onSelect).toHaveBeenCalledTimes(1);
  const removeButton = screen.getByRole('button', { name: i18n.t('chat:favorites.remove') });
  fireEvent.click(removeButton);
  expect(remove).toHaveBeenCalledWith('fav-1');
});
