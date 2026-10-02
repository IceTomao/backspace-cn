import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { androidCall, onAndroid, type NativeVoiceState } from '../../platform/android';
import { useUIStore } from '../../stores/uiStore';

export function AndroidStreamList() {
  const { t } = useTranslation('voice');
  const [streams, setStreams] = useState<NonNullable<NativeVoiceState['streams']>>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const apply = (state: NativeVoiceState) => { if (active) setStreams(state.isDm ? [] : state.streams ?? []); };
    const remove = onAndroid<NativeVoiceState>('voice', apply);
    void androidCall<NativeVoiceState>('voice').then(apply).catch(() => {});
    return () => { active = false; remove(); };
  }, []);
  if (!streams.length) return null;
  async function watch(identity: string) {
    setBusy(true);
    try { await androidCall('watchStream', { identity }); }
    catch (error) { useUIStore.getState().addToast(error instanceof Error ? error.message : t('androidStream.failed'), 'warning'); }
    finally { setBusy(false); }
  }
  return <section aria-label={t('androidStream.title')} className="shrink-0 border-b border-border-soft p-3 space-y-2">
    <h2 className="text-sm font-semibold text-txt-primary">{t('androidStream.title')}</h2>
    <div className="flex flex-wrap gap-2">
      {streams.map(stream => <button key={stream.videoSid} disabled={busy || stream.muted}
        className="rounded-lg px-3 py-2 bg-surface-elevated text-txt-primary text-sm disabled:opacity-50"
        onClick={() => void watch(stream.identity)}>{t(stream.muted ? 'androidStream.paused' : 'androidStream.watch', { name: stream.name || stream.identity.split(':')[1] || stream.identity })}</button>)}
    </div>
  </section>;
}
