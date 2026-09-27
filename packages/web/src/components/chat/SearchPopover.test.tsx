import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useUIStore } from '../../stores/uiStore';
import { SearchPopover } from './SearchPopover';

const searchChannel = vi.hoisted(() => vi.fn());

vi.mock('../../stores/spaceStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../stores/spaceStore')>(),
  getChannelOrigin: () => 'https://example.test',
  getApiForOrigin: () => ({ search: { channel: searchChannel } }),
}));

afterEach(() => {
  useUIStore.setState({ isMobile: false });
  searchChannel.mockReset();
});

it('searches a mobile channel and opens the selected message', async () => {
  useUIStore.setState({ isMobile: true });
  searchChannel.mockResolvedValue({
    results: [{ id: 'message-42', content: 'A needle here', createdAt: Date.now(), user: null, attachments: [] }],
    totalCount: 1,
  });
  const onJumpToMessage = vi.fn();
  const onClose = vi.fn();
  render(<SearchPopover
    open
    onClose={onClose}
    anchorRef={{ current: null }}
    channelId="channel-1"
    isDm={false}
    onJumpToMessage={onJumpToMessage}
  />);

  expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText(/Search messages/), { target: { value: 'needle' } });
  const match = await screen.findByText('needle');
  expect(searchChannel).toHaveBeenCalledWith('channel-1', expect.objectContaining({ q: 'needle' }));
  fireEvent.click(match.closest('button')!);
  expect(onJumpToMessage).toHaveBeenCalledWith('message-42');
});
