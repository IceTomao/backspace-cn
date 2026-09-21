import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { androidCall, onAndroid, type NativeVoiceState } from '../../platform/android';
import { EMPTY_VOICE } from '../../hooks/useAndroidVoice';
import { useVoiceStore } from '../../stores/voiceStore';

export function AndroidAudioSettings() {
  const { t } = useTranslation('settings');
  const [voice, setVoice] = useState<NativeVoiceState>(EMPTY_VOICE);
  const [error, setError] = useState('');
  const volume = useVoiceStore(s => s.outputVolume);
  const allMessages = useVoiceStore(s => s.messageSoundAllChannels);
  useEffect(() => {
    let active = true;
    void androidCall<NativeVoiceState>('voice').then(v => { if (active) setVoice(v); });
    const remove = onAndroid<NativeVoiceState>('voice', setVoice);
    return () => { active = false; remove(); };
  }, []);
  const call = (action: string, data = {}) => {
    setError('');
    void androidCall(action, data).catch(e => setError(e instanceof Error ? e.message : '操作失败，请重试'));
  };
  return <section className="space-y-5 text-sm">
    <h2 className="text-lg font-semibold">{t('voice.title')}</h2>
    <label className="block">{t('android.audioDevice')}
      <select className="input-standard w-full mt-2" disabled={!voice.channelId} value={voice.deviceId ?? 'auto'} onChange={e => call('device', { id: e.target.value })}>
        <option value="auto">{t('android.autoDevice')}</option>
        {voice.devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}
      </select>
    </label>
    <button className="text-txt-link" onClick={() => call('bluetooth')}>{t('android.bluetooth')}</button>
    <label className="block">{t('android.volume')} {volume}%
      <input aria-label={t('android.volume')} className="w-full mt-3" type="range" min="0" max="200" value={volume} onChange={e => useVoiceStore.getState().setOutputVolume(Number(e.target.value))} />
    </label>
    <label className="flex items-center justify-between gap-3">{t('android.allMessages')}
      <input type="checkbox" checked={allMessages} onChange={e => useVoiceStore.getState().setMessageSoundAllChannels(e.target.checked)} />
    </label>
    {error && <p role="alert" className="text-txt-danger">{error}</p>}
  </section>;
}
