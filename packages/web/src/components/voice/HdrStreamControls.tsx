import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useVoiceStore } from '../../stores/voiceStore';
import { useNativeHdrStore } from '../../stores/nativeHdrStore';
import { Toggle } from '../ui/Toggle';

export function HdrStreamControls() {
  const { t } = useTranslation('voice');
  const enabled = useVoiceStore(s => s.screenShareConfig.hdrEnabled);
  const live = useVoiceStore(s => s.isScreenSharing);
  const setConfig = useVoiceStore(s => s.setScreenShareConfig);
  const { publisherAvailable: available, labMode, reason, refresh } = useNativeHdrStore();
  useEffect(() => { void refresh(); }, [refresh]);
  return <div>
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-txt-tertiary font-semibold">{t('streamSettings.hdrEnabled')}</span>
      <Toggle enabled={enabled} disabled={live || (!enabled && !available)}
        onChange={value => setConfig({ hdrEnabled: value })} ariaLabel={t('streamSettings.hdrEnabled')} />
    </div>
    <p className="text-[10px] text-txt-tertiary mt-1.5" role="status">
      {live ? t('streamSettings.hdrLocked') : available ? t('streamSettings.hdrOnly') : t(`streamSettings.hdrReason.${reason}`)}
    </p>
    {labMode && <p className="text-[10px] text-accent-amber mt-1">{t('streamSettings.hdrReason.validation_pending')}</p>}
    {!live && !available && <button type="button" className="text-xs text-accent-primary mt-1" onClick={() => void refresh()}>{t('stream.hdrRecheck')}</button>}
  </div>;
}
