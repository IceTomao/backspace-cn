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
  it('offers the shared user volume without a second stream slider', () => {
    useVoiceStore.setState({
      watchingStreams: new Set(),
      // A stream gain tuned earlier must survive merely opening this menu; only
      // dragging the slider is allowed to move it.
      participantVolumes: new Map([['alice', 80]]),
      streamVolumes: new Map([['alice', 30]]),
    });
    const { container } = render(<StreamTile tile={buildTile()} stats={null} />);

    const tileRoot = container.querySelector('[data-context-menu]');
    expect(tileRoot).not.toBeNull();
    fireEvent.contextMenu(tileRoot!);

    const items = useContextMenuStore.getState().menu?.items ?? [];
    const keys = items.map((item) => item.key);
    expect(keys).toEqual(expect.arrayContaining(['watch-stream', 'mute-stream', 'eq']));
    expect(keys.filter((key) => key === 'volume')).toHaveLength(1);
    expect(keys).not.toContain('stream-volume');

    const volumeItem = items.find((item) => item.key === 'volume');
    if (volumeItem?.type !== 'custom') throw new Error('volume menu item must be custom');

    render(<>{volumeItem.render()}</>);
    expect(screen.getByText('User Volume')).toBeInTheDocument();
    expect(
      screen.getByText("Controls this user's voice and screen-share audio"),
    ).toBeInTheDocument();
    expect(useVoiceStore.getState().streamVolumes.get('alice')).toBe(30);

    fireEvent.change(screen.getByRole('slider'), { target: { value: '40' } });
    expect(useVoiceStore.getState().participantVolumes.get('alice')).toBe(40);
    expect(useVoiceStore.getState().streamVolumes.get('alice')).toBe(40);
  });
});
