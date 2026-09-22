import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { isDmChannel, useSpaceStore, type UserViewEntry } from '../../stores/spaceStore';
import type { DmChannel, MemberWithUser, User } from '@backspace/shared';
import { canonicalUserKey } from '../../utils/identity';

interface TypingIndicatorProps {
  channelId: string;
}

interface TypingIdentity {
  userId: string;
  username: string;
}

function matchesUser(user: User, userId: string): boolean {
  return user.id === userId || user.homeUserId === userId;
}

export function resolveTypingDisplayName(
  typingUser: TypingIdentity,
  channelId: string,
  members: MemberWithUser[],
  dmChannels: DmChannel[],
  userViews: Map<string, UserViewEntry>,
): string {
  const member = isDmChannel(channelId)
    ? undefined
    : members.find((candidate) => candidate.userId === typingUser.userId || matchesUser(candidate.user, typingUser.userId));
  const dmUser = isDmChannel(channelId)
    ? dmChannels.find((channel) => channel.id === channelId)?.members.find((user) => matchesUser(user, typingUser.userId))
    : undefined;
  const rosterUser = member?.user ?? dmUser;
  const canonical = rosterUser
    ? userViews.get(canonicalUserKey(rosterUser))?.user ?? rosterUser
    : undefined;

  return member?.nickname?.trim()
    || canonical?.displayName?.trim()
    || typingUser.username;
}

export function TypingIndicator({ channelId }: TypingIndicatorProps) {
  const { t } = useTranslation('chat');
  const typingUsersRaw = useChatStore((s) => s.typingUsers.get(channelId));
  const currentUserId = useAuthStore((s) => s.user?.id);
  const members = useSpaceStore((s) => s.members);
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const userViews = useSpaceStore((s) => s.userViews);

  // Filter out current user and expired entries
  const others = useMemo(() => {
    if (!typingUsersRaw || typingUsersRaw.length === 0) return [];
    const now = Date.now();
    return typingUsersRaw
      .filter(t => now - t.timestamp < 5000 && t.userId !== currentUserId);
  }, [typingUsersRaw, currentUserId]);

  if (others.length === 0) return null;

  const names = others.map((user) => resolveTypingDisplayName(user, channelId, members, dmChannels, userViews));
  let text: string;
  if (others.length === 1) {
    text = t('typing.one', { name: names[0] });
  } else if (others.length === 2) {
    text = t('typing.two', { first: names[0], second: names[1] });
  } else {
    text = t('typing.many');
  }

  return (
    <div className="absolute bottom-full left-1 desktop:left-4 mb-1 px-3 flex items-center text-[12px] text-txt-secondary font-medium select-none pointer-events-none animate-typing-in motion-reduce:animate-none">
      <div className="flex items-center gap-2">
        <div className="flex gap-[2px] bg-surface-elevated/20 rounded-full px-2 py-1">
          <div className="w-[5px] h-[5px] bg-txt-message rounded-full animate-bounce" style={{ animationDelay: '0ms', animationDuration: '0.8s' }} />
          <div className="w-[5px] h-[5px] bg-txt-message rounded-full animate-bounce" style={{ animationDelay: '150ms', animationDuration: '0.8s' }} />
          <div className="w-[5px] h-[5px] bg-txt-message rounded-full animate-bounce" style={{ animationDelay: '300ms', animationDuration: '0.8s' }} />
        </div>
        <span className="truncate max-w-[400px]">
          <span className="font-bold">{text}</span>
        </span>
      </div>
    </div>
  );
}
