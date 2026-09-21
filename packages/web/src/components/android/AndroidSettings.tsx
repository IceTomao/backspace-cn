import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { androidCall, onAndroid, serverLocation, type AndroidPreferences } from '../../platform/android';
import { switchAndroidServer } from '../../platform/appStorage';

function errorText(error: unknown): string { return error instanceof Error ? error.message : '操作失败，请重试'; }

export function AndroidSettings({ serverOnly = false }: { serverOnly?: boolean }) {
  const { t } = useTranslation('settings');
  const [settings, setSettings] = useState<AndroidPreferences | null>(null);
  const [server, setServer] = useState(serverLocation().origin);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void androidCall<AndroidPreferences>('preferences').then(value => { if (active) setSettings(value); }).catch(e => setError(errorText(e)));
    const remove = onAndroid<AndroidPreferences>('preferences', setSettings);
    return () => { active = false; remove(); };
  }, []);
  async function update(data: Record<string, unknown>) {
    setBusy(true); setError('');
    try { setSettings(await androidCall<AndroidPreferences>('preferences', data)); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  async function changeServer() {
    if (!window.confirm(t('android.switchConfirm'))) return;
    setBusy(true); setError('');
    try { await switchAndroidServer(server); }
    catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return <section className="space-y-4 text-sm text-txt-primary">
    {!serverOnly && settings && <>
      <fieldset disabled={busy} className="space-y-2">
        <legend className="font-semibold mb-2">{t('android.theme')}</legend>
        <div className="flex flex-wrap gap-4">
          {(['system', 'light', 'dark'] as const).map(value =>
            <label key={value} className="flex items-center gap-2">
              <input type="radio" name="android-theme" checked={settings.theme === value} onChange={() => void update({ theme: value })} />{t(`android.${value}`)}
            </label>)}
        </div>
      </fieldset>
      <label className="flex items-center justify-between gap-3 py-3 border-y border-border-soft">
        {t('android.background')}
        <input type="checkbox" disabled={busy} checked={settings.background} onChange={e => void update({ background: e.target.checked })} />
      </label>
    </>}
    <label className="block">
      <span className="block font-semibold mb-2">{t('android.server')}</span>
      <input type="url" className="input-standard w-full" value={server} disabled={busy} onChange={e => setServer(e.target.value)} autoCapitalize="none" autoCorrect="off" />
    </label>
    <button type="button" className="px-4 py-2 rounded bg-accent-primary text-white disabled:opacity-50" disabled={busy} onClick={() => void changeServer()}>
      {busy ? t('android.busy') : t('android.switch')}
    </button>
    {error && <p role="alert" className="text-txt-danger break-words">{error}</p>}
  </section>;
}
