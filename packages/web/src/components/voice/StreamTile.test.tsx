import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { StreamTile } from './StreamTile';
import { useVoiceStore } from '../../stores/voiceStore';
import { useUIStore } from '../../stores/uiStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import type { StreamTile as StreamTileType } from '../../hooks/useLiveKit';

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({}) },
}));

vi.mock('../../hooks/useLiveKit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/useLiveKit')>();
  return {
    ...actual,
    getActiveRoom: () => null,
    setStreamSubscription: vi.fn(),
  };
});

const screenTrack = {
  readyState: 'live',
  getSettings: () => ({ width: 1920, height: 1080, frameRate: 60 }),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
} as unknown as MediaStreamTrack;

function buildTile(): StreamTileType {
  return {
    kind: 'stream',
    key: 'alice:stream',
    participant: {
      identity: 'alice@nova.test',
      userId: 'alice',
      username: 'Ada',
      homeUserId: 'alice',
      isMuted: false,
      isDeafened: false,
      isCameraOn: false,
      isScreenSharing: true,
      isLocal: false,
      audioTrack: null,
      videoTrack: null,
      screenTrack,
      screenAudioTrack: null,
      lkVideoTrack: null,
      lkScreenTrack: null,
      cachedUser: null,
    } as unknown as StreamTileType['participant'],
    screenTrack,
    screenAudioTrack: null,
    lkScreenTrack: null,
  };
}

beforeEach(() => {
  useUIStore.setState({ voiceFullscreen: false });
  useVoiceStore.setState({
    watchingStreams: new Set(['alice']),
    participantVolumes: new Map(),
    streamVolumes: new Map(),
    voiceUserStates: new Map(),
    voiceConnectionStatus: 'connected',
    connectionQuality: 'excellent',
    connectionQualities: new Map(),
  });
  useContextMenuStore.getState().close();
});

describe('StreamTile caption identity', () => {
  it('puts the broadcaster avatar before the name in the caption', () => {
    render(<StreamTile tile={buildTile()} stats={null} />);

    const caption = screen.getByTestId('stream-tile-caption');
    const avatar = caption.querySelector('[data-avatar]');
    expect(avatar).not.toBeNull();
    expect(avatar).toHaveStyle({ width: '20px', height: '20px' });

    const name = within(caption).getByText('Ada');
    expect(avatar!.nextElementSibling).toBe(name);
  });
});

describe('StreamTile context menu', () => {
  it('offers separate voice and screen-share sliders for a sharing participant', () => {
    const tile = buildTile();
    useVoiceStore.setState({
      watchingStreams: new Set(),
      participants: [tile.participant],
      participantVolumes: new Map([['alice', 80]]),
      streamVolumes: new Map([['alice', 30]]),
    });
    const { container } = render(<StreamTile tile={tile} stats={null} />);

    const tileRoot = container.querySelector('[data-context-menu]');
    expect(tileRoot).not.toBeNull();
    fireEvent.contextMenu(tileRoot!);

    const items = useContextMenuStore.getState().menu?.items ?? [];
    const keys = items.map((item) => item.key);
    expect(keys).toEqual(expect.arrayContaining(['watch-stream', 'mute-stream', 'volume', 'stream-volume', 'eq']));

    const voiceItem = items.find((item) => item.key === 'volume');
    if (voiceItem?.type !== 'custom') throw new Error('volume menu item must be custom');
    const voiceView = render(<>{voiceItem.render()}</>);
    expect(screen.getByText('User Volume')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '40' } });
    expect(useVoiceStore.getState().participantVolumes.get('alice')).toBe(40);
    // Voice volume must not drag the screen-share gain along any more.
    expect(useVoiceStore.getState().streamVolumes.get('alice')).toBe(30);
    voiceView.unmount();

    const streamItem = items.find((item) => item.key === 'stream-volume');
    if (streamItem?.type !== 'custom') throw new Error('stream volume menu item must be custom');
    const streamView = render(<>{streamItem.render()}</>);
    expect(screen.getByText('Screen Share Volume')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Share'), { target: { value: '55' } });
    expect(useVoiceStore.getState().streamVolumes.get('alice')).toBe(55);
    expect(useVoiceStore.getState().participantVolumes.get('alice')).toBe(40);

    // Reset drops the entry instead of pinning it to 100, so a later share
    // starts at unity rather than at a value kept from this one.
    fireEvent.click(screen.getByText('Reset to 100%'));
    expect(useVoiceStore.getState().streamVolumes.has('alice')).toBe(false);
    streamView.unmount();
  });

  it('hides the screen-share slider when the participant is not sharing', () => {
    const tile = buildTile();
    useVoiceStore.setState({
      watchingStreams: new Set(),
      // The tile still renders, but the store — the only thing that knows the
      // live share state when the menu opens — says this person is not sharing.
      participants: [{ ...tile.participant, isScreenSharing: false }],
      participantVolumes: new Map(),
      streamVolumes: new Map(),
    });
    const { container } = render(<StreamTile tile={tile} stats={null} />);

    fireEvent.contextMenu(container.querySelector('[data-context-menu]')!);

    const keys = (useContextMenuStore.getState().menu?.items ?? []).map((item) => item.key);
    expect(keys).toContain('volume');
    expect(keys).not.toContain('stream-volume');
  });
});
