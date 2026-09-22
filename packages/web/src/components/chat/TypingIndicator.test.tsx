import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberWithUser, User } from '@backspace/shared';
import { setLanguage } from '../../i18n';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { resolveTypingDisplayName, TypingIndicator } from './TypingIndicator';

vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));

function user(id: string, displayName: string | null): User {
  return {
    id, username: `${id}-login`, displayName, avatar: null, banner: null,
    accentColor: null, avatarColor: null, bio: null, status: 'online', customStatus: null,
    isAdmin: false, createdAt: 1, homeInstance: null, homeUserId: null, replicatedInstances: [],
  };
}

function member(value: User, nickname: string | null): MemberWithUser {
  return { spaceId: 'space-1', userId: value.id, nickname, joinedAt: 1, user: value, roles: [] };
}

const me = user('me', '我');
const typer = user('typer', '个人显示名');

beforeEach(() => {
  useAuthStore.setState({ user: me });
  useSpaceStore.setState({ members: [member(typer, '社区昵称')], dmChannels: [], userViews: new Map() });
  useChatStore.setState({ typingUsers: new Map() });
});

afterEach(async () => {
  await setLanguage('en');
  useAuthStore.setState({ user: null });
});

describe('typing indicator names', () => {
  it('prefers community nickname, then display name, then username', () => {
    const entry = { userId: typer.id, username: typer.username };
    expect(resolveTypingDisplayName(entry, 'channel-1', [member(typer, '社区昵称')], [], new Map())).toBe('社区昵称');
    expect(resolveTypingDisplayName(entry, 'channel-1', [member(typer, null)], [], new Map())).toBe('个人显示名');
    expect(resolveTypingDisplayName(entry, 'channel-1', [member(user('typer', null), null)], [], new Map())).toBe('typer-login');
  });

  it('renders a Chinese display name with the localized sentence', async () => {
    await setLanguage('zh');
    useChatStore.setState({
      typingUsers: new Map([['channel-1', [{ userId: typer.id, username: typer.username, timestamp: Date.now() }]]]),
    });

    render(<TypingIndicator channelId="channel-1" />);
    expect(screen.getByText('社区昵称正在输入…')).toBeInTheDocument();
  });

  it('filters the current user and expired entries and localizes two active users', async () => {
    await setLanguage('zh');
    const second = user('second', '第二位');
    useSpaceStore.setState({ members: [member(typer, null), member(second, null)] });
    useChatStore.setState({
      typingUsers: new Map([['channel-1', [
        { userId: me.id, username: me.username, timestamp: Date.now() },
        { userId: 'expired', username: 'expired', timestamp: Date.now() - 6_000 },
        { userId: typer.id, username: typer.username, timestamp: Date.now() },
        { userId: second.id, username: second.username, timestamp: Date.now() },
      ]]]),
    });

    render(<TypingIndicator channelId="channel-1" />);
    expect(screen.getByText('个人显示名和第二位正在输入…')).toBeInTheDocument();
  });
});
