import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useFavoriteMediaStore } from '../../stores/favoriteMediaStore';
import { FavoriteMediaPicker } from './FavoriteMediaPicker';
import i18n from '../../i18n';

afterEach(() => {
  vi.unstubAllGlobals();
  useFavoriteMediaStore.getState().reset();
});

it('refreshes the collection and exposes remove and send on touch layouts', async () => {
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

  render(<FavoriteMediaPicker mobile onSelect={onSelect} />);
  expect(load).toHaveBeenCalledOnce();
  const removeButton = screen.getByRole('button', { name: i18n.t('chat:favorites.remove') });
  expect(removeButton.className).not.toContain('hidden');
  fireEvent.click(removeButton);
  expect(remove).toHaveBeenCalledWith('fav-1');

  const image = await screen.findByRole('img', { name: 'sticker.png' });
  fireEvent.click(image.closest('button')!);
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'sticker.png', type: 'image/png' })));
});
