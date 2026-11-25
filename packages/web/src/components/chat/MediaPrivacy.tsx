import { createContext, useContext, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMediaPrivacyStore } from '../../stores/mediaPrivacyStore';

export const MediaPrivacyChannel = createContext<string | null>(null);
export const MediaPrivacyMessage = createContext('');

export function mediaItemKey(message: string, item: string): string {
  return JSON.stringify([message, item]);
}

export function useMediaCovered(item: string | undefined): boolean {
  const channelId = useContext(MediaPrivacyChannel);
  return useMediaPrivacyStore((state) => Boolean(channelId && item && (
    state.visit?.channelId !== channelId || state.enabled === null ||
    (state.enabled && !state.showAll && !state.revealed.has(item))
  )));
}

export function MediaPrivacyItem({ item, children, compact = false }: { item: string; children: ReactNode; compact?: boolean }) {
  const { t } = useTranslation('chat');
  const channelId = useContext(MediaPrivacyChannel);
  const message = useContext(MediaPrivacyMessage);
  const key = mediaItemKey(message, item);
  const covered = useMediaCovered(key);
  const canReveal = useMediaPrivacyStore((state) => state.visit?.channelId === channelId && state.enabled === true);

  if (!covered) return <>{children}</>;
  return (
    <button
      type="button"
      disabled={!canReveal}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        useMediaPrivacyStore.getState().reveal(key);
      }}
      aria-label={t('mediaPrivacy.reveal')}
      className={`inline-flex items-center justify-center gap-2 rounded-lg border border-border-hard bg-surface-input px-3 text-sm font-medium text-txt-secondary enabled:hover:bg-interactive-hover enabled:hover:text-txt-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary ${compact ? 'm-3 h-20 w-20 shrink-0' : 'mt-1 min-h-24 w-64 max-w-full'}`}
    >
      <EyeOff className="h-5 w-5 shrink-0" aria-hidden="true" />
      {!compact && t('mediaPrivacy.reveal')}
    </button>
  );
}

export function MediaPrivacyButton({ channelId }: { channelId: string }) {
  const { t } = useTranslation('chat');
  const enabled = useMediaPrivacyStore((state) => state.visit?.channelId === channelId && state.enabled === true);
  const showAll = useMediaPrivacyStore((state) => state.showAll);
  if (!enabled) return null;

  const label = t(showAll ? 'mediaPrivacy.restore' : 'mediaPrivacy.showAll');
  const Icon = showAll ? EyeOff : Eye;
  return (
    <button
      type="button"
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-txt-secondary hover:bg-interactive-hover hover:text-txt-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary desktop:h-8 desktop:w-8"
      aria-label={label}
      title={label}
      onClick={() => useMediaPrivacyStore.getState().toggleAll()}
    >
      <Icon className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}
