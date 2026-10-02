import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAndroidUpdateStore } from '../../stores/androidUpdateStore';
import { useUIStore } from '../../stores/uiStore';

function useUpdates() {
  const { t } = useTranslation('settings');
  const store = useAndroidUpdateStore();
  useEffect(() => store.initialize(), [store.initialize]);
  const download = () => {
    void store.download().catch(() => useUIStore.getState().addToast(t('android.updates.downloadFailed'), 'warning'));
  };
  return { ...store, download, t };
}

export function AndroidUpdateSection() {
  const { snapshot, check, download, t } = useUpdates();
  return <section aria-label={t('android.updates.title')} className="space-y-2 py-3 border-b border-border-soft">
    <h2 className="font-semibold">{t('android.updates.title')}</h2>
    <p className="text-xs text-txt-secondary">{t('android.updates.current', { version: snapshot?.currentVersion ?? '…' })}</p>
    <p role="status" className="text-xs text-txt-secondary">{t(`android.updates.${snapshot?.phase ?? 'idle'}`, { version: snapshot?.version })}</p>
    <div className="flex flex-wrap gap-2">
      <button disabled={!snapshot || snapshot.phase === 'checking' || snapshot.phase === 'unsupported'}
        className="px-3 py-2 rounded bg-surface-elevated text-txt-primary disabled:opacity-50" onClick={() => void check(true)}>{t('android.updates.check')}</button>
      {snapshot?.phase === 'available' && <button className="px-3 py-2 rounded bg-accent-primary text-white" onClick={download}>{t('android.updates.download')}</button>}
    </div>
    <p className="text-xs text-txt-tertiary">{t('android.updates.installNote')}</p>
  </section>;
}

export function AndroidUpdatePrompt() {
  const { snapshot, dismiss, download, t } = useUpdates();
  if (snapshot?.phase !== 'available' || snapshot.dismissedVersion === snapshot.version) return null;
  return <aside role="status" className="fixed z-[300] inset-x-3 rounded-xl p-4 bg-surface-elevated text-txt-primary border border-border-soft shadow-lg"
    style={{ bottom: 'calc(var(--safe-bottom, 0px) + 5rem)' }}>
    <p className="text-sm font-semibold">{t('android.updates.available', { version: snapshot.version })}</p>
    <div className="flex gap-3 mt-3">
      <button className="px-3 py-2 rounded bg-accent-primary text-white text-sm" onClick={download}>{t('android.updates.download')}</button>
      <button className="px-3 py-2 text-sm" onClick={() => void dismiss().catch(() => {})}>{t('android.updates.later')}</button>
    </div>
  </aside>;
}
