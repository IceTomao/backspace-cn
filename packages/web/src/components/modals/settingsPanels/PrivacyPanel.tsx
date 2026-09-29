import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../../stores/authStore';
import { useActivityStore } from '../../../stores/activityStore';
import { api } from '../../../api/client';
import { Toggle } from '../../ui/Toggle';
import {
  disableWebPush,
  enableWebPush,
  syncWebPushSubscription,
  WebPushSetupError,
  type WebPushSetupErrorCode,
} from '../../../platform/notifications';
import { androidCall, isAndroid, onAndroid, type AndroidPreferences } from '../../../platform/android';

function AndroidNotificationSetting() {
  const { t } = useTranslation('settings');
  const [settings, setSettings] = useState<AndroidPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void androidCall<AndroidPreferences>('preferences').then(setSettings).catch(() => setError(t('android.failed')));
    return onAndroid<AndroidPreferences>('preferences', setSettings);
  }, [t]);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError('');
    try {
      const update = enabled ? { messageNotifications: true, background: true } : { messageNotifications: false };
      setSettings(await androidCall<AndroidPreferences>('preferences', update));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('android.failed'));
    } finally {
      setBusy(false);
    }
  };

  return <div>
    <div className="text-[11px] font-semibold text-txt-tertiary uppercase mb-1.5">{t('android.notifications')}</div>
    <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
      <div className="flex items-center justify-between py-1">
        <div className="flex-1 mr-4">
          <div className="text-sm text-txt-primary">{t('android.messageNotifications')}</div>
          <div className="text-xs text-txt-tertiary mt-0.5">{t('android.messageNotificationsDescription')}</div>
        </div>
        <Toggle ariaLabel={t('android.messageNotifications')} enabled={Boolean(settings?.messageNotifications && settings.notificationsAllowed && settings.background)} disabled={busy || !settings} onChange={(enabled) => void toggle(enabled)} />
      </div>
      {settings && !settings.notificationsAllowed && <p className="text-xs text-txt-tertiary mt-2">{t('android.notificationPermission')}</p>}
      {error && <p role="alert" className="text-xs text-txt-danger mt-2">{error}</p>}
    </div>
  </div>;
}

export function PrivacyPanel() {
  const { t } = useTranslation(['settings', 'common']);
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const showActivity = useActivityStore((s) => s.showActivity);
  const [discoverable, setDiscoverable] = useState(user?.discoverable !== false);
  const [saving, setSaving] = useState(false);
  const [activityPreferences, setActivityPreferences] = useState({ showGames: true, showMusic: true, showActivityImages: true });
  const [webPushEnabled, setWebPushEnabled] = useState(false);
  const [webPushBusy, setWebPushBusy] = useState(false);
  const [webPushError, setWebPushError] = useState<WebPushSetupErrorCode | 'unknown' | null>(null);
  const [webPushDiagnostic, setWebPushDiagnostic] = useState<WebPushSetupError['diagnostic']>();
  const hasDesktopPreferences = Boolean(window.backspace?.getActivityPreferences);

  useEffect(() => {
    setDiscoverable(user?.discoverable !== false);
  }, [user?.discoverable]);

  useEffect(() => {
    window.backspace?.getActivityPreferences?.().then(setActivityPreferences).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setWebPushError(null);
    setWebPushDiagnostic(undefined);
    if (!user?.id) {
      setWebPushEnabled(false);
      return;
    }
    void syncWebPushSubscription().then((enabled) => {
      if (!cancelled) setWebPushEnabled(enabled);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setWebPushEnabled(false);
      setWebPushError(error instanceof WebPushSetupError ? error.code : 'unknown');
      if (error instanceof WebPushSetupError) setWebPushDiagnostic(error.diagnostic);
    });
    return () => { cancelled = true; };
  }, [user?.id]);

  const toggleWebPush = async (enabled: boolean) => {
    const wasEnabled = webPushEnabled;
    setWebPushBusy(true);
    setWebPushError(null);
    setWebPushDiagnostic(undefined);
    try {
      const result = enabled ? await enableWebPush() : await disableWebPush();
      setWebPushEnabled(enabled && result === true);
    } catch (error) {
      if (enabled) setWebPushEnabled(false);
      else setWebPushEnabled(wasEnabled);
      setWebPushError(error instanceof WebPushSetupError ? error.code : 'unknown');
      if (error instanceof WebPushSetupError) setWebPushDiagnostic(error.diagnostic);
    } finally {
      setWebPushBusy(false);
    }
  };

  const webPushErrorText = webPushError
    ? t(`settings:privacy.webPush.errors.${webPushError}`)
    : null;

  const setActivityPreference = async (patch: { showGames?: boolean; showMusic?: boolean; showActivityImages?: boolean }) => {
    const previous = activityPreferences;
    const next = { ...previous, ...patch };
    setActivityPreferences(next);
    try {
      const saved = await window.backspace?.setActivityPreferences?.(patch);
      if (saved) setActivityPreferences(saved);
    } catch {
      setActivityPreferences(previous);
    }
  };

  const handleToggle = async (enabled: boolean) => {
    setDiscoverable(enabled);
    setSaving(true);
    try {
      const updated = await api.users.update({ discoverable: enabled });
      setUser(updated);
    } catch {
      // Revert on failure
      setDiscoverable(!enabled);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary mb-6">{t('settings:privacy.title')}</h2>
      {isAndroid() ? <AndroidNotificationSetting /> : <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">{t('settings:privacy.webPush.sectionTitle')}</div>
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
          <div className="flex items-center justify-between py-1">
            <div className="flex-1 mr-4">
              <div className="text-sm text-txt-primary">{t('settings:privacy.webPush.label')}</div>
              <div className="text-xs text-txt-tertiary mt-0.5">{t('settings:privacy.webPush.description')}</div>
            </div>
            <Toggle enabled={webPushEnabled} disabled={webPushBusy} onChange={(enabled) => void toggleWebPush(enabled)} />
          </div>
          {webPushErrorText && <p role="alert" className="text-xs text-txt-danger mt-2">{webPushErrorText}</p>}
          {webPushDiagnostic && (
            <p className="text-xs text-txt-tertiary mt-1 break-words">
              {t(`settings:privacy.webPush.stages.${webPushDiagnostic.stage}`)}: {webPushDiagnostic.errorName}
              {webPushDiagnostic.errorMessage ? `: ${webPushDiagnostic.errorMessage}` : ''}
            </p>
          )}
        </div>
      </div>}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          {t('settings:privacy.discovery.sectionTitle')}
        </div>
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
          <div className="flex items-center justify-between py-1">
            <div className="flex-1 mr-4">
              <div className="text-sm text-txt-primary">{t('settings:privacy.discovery.label')}</div>
              <div className="text-xs text-txt-tertiary mt-0.5">
                {t('settings:privacy.discovery.description')}
              </div>
            </div>
            <Toggle enabled={discoverable} onChange={handleToggle} />
          </div>
          {saving && (
            <div className="text-xs text-txt-tertiary mt-2">{t('common:states.saving')}</div>
          )}
        </div>
      </div>

      {/* Activity Status */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          {t('settings:privacy.activity.sectionTitle')}
        </div>
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
          <div className="flex items-center justify-between py-1">
            <div className="flex-1 mr-4">
              <div className="text-sm text-txt-primary">{t('settings:privacy.activity.label')}</div>
              <div className="text-xs text-txt-tertiary mt-0.5">
                {t('settings:privacy.activity.description')}
              </div>
            </div>
            <Toggle
              enabled={showActivity}
              onChange={async (enabled) => {
                try {
                  await api.users.update({ showActivity: enabled });
                  useActivityStore.getState().setShowActivity(enabled);
                } catch (err) {
                  console.error('Failed to update activity visibility:', err);
                }
              }}
            />
          </div>
          {hasDesktopPreferences && (
            <div className="border-t border-white/[0.04] mt-3 pt-2 space-y-2">
              <div className="flex items-center justify-between py-1">
                <div className="flex-1 mr-4">
                  <div className="text-sm text-txt-primary">{t('settings:privacy.activity.gamesLabel')}</div>
                  <div className="text-xs text-txt-tertiary mt-0.5">{t('settings:privacy.activity.gamesDescription')}</div>
                </div>
                <Toggle enabled={activityPreferences.showGames} onChange={(showGames) => void setActivityPreference({ showGames })} />
              </div>
              <div className="flex items-center justify-between py-1">
                <div className="flex-1 mr-4">
                  <div className="text-sm text-txt-primary">{t('settings:privacy.activity.musicLabel')}</div>
                  <div className="text-xs text-txt-tertiary mt-0.5">{t('settings:privacy.activity.musicDescription')}</div>
                </div>
                <Toggle enabled={activityPreferences.showMusic} onChange={(showMusic) => void setActivityPreference({ showMusic })} />
              </div>
              <div className="flex items-center justify-between py-1">
                <div className="flex-1 mr-4">
                  <div className="text-sm text-txt-primary">{t('settings:privacy.activity.imagesLabel')}</div>
                  <div className="text-xs text-txt-tertiary mt-0.5">{t('settings:privacy.activity.imagesDescription')}</div>
                </div>
                <Toggle enabled={activityPreferences.showActivityImages} onChange={(showActivityImages) => void setActivityPreference({ showActivityImages })} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
