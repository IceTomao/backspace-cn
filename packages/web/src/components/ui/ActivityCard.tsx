import type { Activity } from '@backspace/shared';
import { getPrimaryActivity } from '@backspace/shared/src/activities.js';
import type { TFunction } from 'i18next';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface ActivityCardProps {
  activities: Activity[];
  fallbackCustomStatus?: string | null;
}

function formatElapsed(startMs: number, now: number, t: TFunction<'common'>): string {
  const elapsed = Math.max(0, now - startMs);
  const minutes = Math.floor(elapsed / 60000);
  const hours = Math.floor(minutes / 60);
  const duration = hours > 0
    ? t('time.hoursMinutesShort', { hours, minutes: minutes % 60 })
    : t('time.minutesShort', { minutes });
  return t('time.elapsed', { duration });
}

function useActivityClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** Returns the accent border color class for an activity type */
export function getActivityAccentClass(type: Activity['type']): string {
  switch (type) {
    case 'playing': return 'border-l-accent-mint';
    case 'listening': return 'border-l-accent-sky';
    case 'watching': return 'border-l-accent-lavender';
    case 'streaming': return 'border-l-accent-rose';
    default: return '';
  }
}

/** Returns whether an activity should get the glass card row treatment */
export function hasRichActivity(activities: Activity[]): boolean {
  const primary = getPrimaryActivity(activities);
  return !!primary && primary.type !== 'custom';
}

/**
 * Renders activity details (app name + elapsed time).
 * The glass card wrapper is applied by the parent row container.
 */
export function ActivityCard({ activities, fallbackCustomStatus }: ActivityCardProps) {
  const { t } = useTranslation('common');
  const primary = getPrimaryActivity(activities);
  const now = useActivityClock(Boolean(primary?.timestamps?.start));

  if (!primary) {
    if (fallbackCustomStatus) {
      return <div className="text-[11px] leading-[1.3] text-txt-tertiary truncate">{fallbackCustomStatus}</div>;
    }
    return null;
  }

  // Custom status — plain text, no card treatment
  if (primary.type === 'custom') {
    return <div className="text-[11px] leading-[1.3] text-txt-tertiary truncate">{primary.name}</div>;
  }

  const music = primary.type === 'listening' ? null : activities.find((activity) => activity.type === 'listening');
  const publicImage = primary.assets?.largeImage?.startsWith('https://') ? primary.assets.largeImage : null;
  const musicImage = music?.assets?.largeImage?.startsWith('https://') ? music.assets.largeImage : null;

  // Rich activity — details, status, and elapsed (card wrapper is on the parent row)
  return (
    <>
      <div className="flex min-w-0 gap-2">
        {publicImage && (
          <img src={publicImage} alt="" className="w-8 h-8 shrink-0 rounded object-cover" />
        )}
        <div className="min-w-0">
          <div className="text-[11px] leading-[1.3] text-txt-secondary truncate">
            {primary.name}
          </div>
          {primary.details && <div className="text-[10px] leading-[1.3] text-txt-primary truncate">{primary.details}</div>}
          {primary.state && <div className="text-[10px] leading-[1.3] text-txt-tertiary truncate">{primary.state}</div>}
        </div>
      </div>
      {primary.timestamps?.start && (
        <div className="text-[10px] leading-[1.3] text-txt-tertiary">
          {formatElapsed(primary.timestamps.start, now, t)}
        </div>
      )}
      {music && (
        <div className="mt-1 flex min-w-0 items-center gap-1 text-[10px] leading-[1.3] text-txt-tertiary">
          {musicImage && <img src={musicImage} alt="" className="w-3.5 h-3.5 shrink-0 rounded object-contain" />}
          <span className="truncate">
            {music.details ? `${music.name} · ${music.details}` : music.name}
            {music.state ? ` · ${music.state}` : ''}
          </span>
        </div>
      )}
    </>
  );
}
