import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Activity, User } from '@backspace/shared';
import { useActivityStore } from '../../stores/activityStore';

const EMPTY_ACTIVITIES: Activity[] = [];

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

function formatElapsed(start: number, now: number, t: TFunction<'common'>): string {
  const minutes = Math.floor(Math.max(0, now - start) / 60_000);
  const hours = Math.floor(minutes / 60);
  const duration = hours > 0
    ? t('time.hoursMinutesShort', { hours, minutes: minutes % 60 })
    : t('time.minutesShort', { minutes });
  return t('time.elapsed', { duration });
}

/** Full-fidelity activity details intended for profile surfaces, not list rows. */
export function ProfileActivityDetails({ user }: { user: User }) {
  const { t: tSocial } = useTranslation('social');
  const { t: tCommon } = useTranslation('common');
  const activities = useActivityStore((state) =>
    state.userActivities.get(user.homeUserId ?? user.id) ?? EMPTY_ACTIVITIES,
  );
  const visibleActivities = activities.filter((activity) => activity.type !== 'custom');
  const now = useActivityClock(visibleActivities.some((activity) => activity.timestamps?.start));

  if (!visibleActivities.length) return null;

  return (
    <section data-profile-activities className="border-t border-white/[0.06] pt-3">
      <h3 className="text-[11px] uppercase tracking-wide font-semibold text-txt-tertiary mb-2">
        {tSocial('profile.activity.title')}
      </h3>
      <div className="space-y-3">
        {visibleActivities.map((activity, index) => {
          const isMusic = activity.type === 'listening';
          const image = activity.assets?.largeImage?.startsWith('https://') ? activity.assets.largeImage : null;
          return (
            <div key={`${activity.type}:${activity.name}:${index}`} className="flex min-w-0 gap-3">
              {image && <img src={image} alt="" className="w-10 h-10 shrink-0 rounded object-cover" />}
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium leading-[1.35] text-txt-primary break-words">
                  {isMusic
                    ? tSocial('profile.activity.listening', { name: activity.name })
                    : tSocial('profile.activity.playing', { name: activity.name })}
                </div>
                {activity.details && <div className="text-[13px] leading-[1.35] text-txt-secondary break-words">{activity.details}</div>}
                {activity.state && <div className="text-[12px] leading-[1.35] text-txt-tertiary break-words">{activity.state}</div>}
                {activity.timestamps?.start && (
                  <div className="mt-0.5 text-[11px] leading-[1.35] text-txt-tertiary">
                    {formatElapsed(activity.timestamps.start, now, tCommon)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
