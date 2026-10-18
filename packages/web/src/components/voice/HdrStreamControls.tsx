import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVoiceStore } from '../../stores/voiceStore';
import { useNativeHdrStore } from '../../stores/nativeHdrStore';
import { Toggle } from '../ui/Toggle';

export function HdrStreamControls() {
  const { t } = useTranslation('voice');
  const enabled = useVoiceStore(s => s.screenShareConfig.hdrEnabled);
  const live = useVoiceStore(s => s.isScreenSharing);
  const setConfig = useVoiceStore(s => s.setScreenShareConfig);
  const exposureEv = useVoiceStore(s => s.screenShareConfig.hdrExposureEv);
  const brightness = useVoiceStore(s => s.screenShareConfig.hdrBrightness);
  const { publisherAvailable: available, labMode, experimental, reason, refresh, colorControl, pendingColor, colorError, setColor } = useNativeHdrStore();
  const [checking, setChecking] = useState(false);
  const id = useId();
  const color = pendingColor ?? { exposureEv, brightness };
  const colorDisabled = !colorControl;
  useEffect(() => { void refresh(); }, [refresh]);
  const toggleHdr = async (value: boolean) => {
    if (!value) { setConfig({ hdrEnabled: false }); return; }
    setChecking(true);
    try { await refresh(true); if (useNativeHdrStore.getState().publisherAvailable) setConfig({ hdrEnabled: true }); }
    finally { setChecking(false); }
  };
  return <div>
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-txt-tertiary font-semibold">{t('streamSettings.hdrEnabled')}</span>
      <Toggle enabled={enabled} disabled={live || checking || (!enabled && !available)}
        onChange={value => void toggleHdr(value)} ariaLabel={t('streamSettings.hdrEnabled')} />
    </div>
    <p className="text-[10px] text-txt-tertiary mt-1.5" role="status">
      {checking ? t('streamSettings.hdrChecking') : live ? t('streamSettings.hdrLocked') : available ? t('streamSettings.hdrOnly') : t(`streamSettings.hdrReason.${reason}`)}
    </p>
    {(labMode || experimental) && <p className="text-[10px] text-accent-amber mt-1">{t('streamSettings.hdrExperimental')}</p>}
    {enabled && <fieldset className="mt-3 space-y-3" disabled={colorDisabled}>
      <legend className="text-[11px] text-txt-secondary mb-2">{t('streamSettings.hdrPicture')}</legend>
      <div>
        <label htmlFor={`${id}-exposure`} className="flex justify-between text-xs text-txt-secondary">
          <span>{t('streamSettings.hdrExposure')}</span><span>{color.exposureEv > 0 ? '+' : ''}{color.exposureEv.toFixed(1)} EV</span>
        </label>
        <input id={`${id}-exposure`} aria-label={t('streamSettings.hdrExposure')} type="range" min={-3} max={3} step={0.1} value={color.exposureEv}
          className="w-full accent-[var(--color-accent-primary)]"
          onChange={event => setColor({ ...color, exposureEv: Number(event.target.value) })} />
      </div>
      <div>
        <label htmlFor={`${id}-brightness`} className="flex justify-between text-xs text-txt-secondary">
          <span>{t('streamSettings.hdrBrightness')}</span><span>{color.brightness > 0 ? '+' : ''}{color.brightness}</span>
        </label>
        <input id={`${id}-brightness`} aria-label={t('streamSettings.hdrBrightness')} type="range" min={-50} max={50} step={1} value={color.brightness}
          className="w-full accent-[var(--color-accent-primary)]"
          onChange={event => setColor({ ...color, brightness: Number(event.target.value) })} />
      </div>
      <p className="text-[10px] text-txt-tertiary">{t('streamSettings.hdrColorHint')}</p>
      <button type="button" className="text-xs text-accent-primary" onClick={() => setColor({ exposureEv: 0, brightness: 0 })}>{t('streamSettings.hdrReset')}</button>
      {colorDisabled && <p className="text-[10px] text-accent-amber">{t('streamSettings.hdrColorUnsupported')}</p>}
      {colorError && <p className="text-xs text-accent-red" role="alert">{t('streamSettings.hdrColorFailed')}</p>}
    </fieldset>}
    {!live && !available && <button type="button" className="text-xs text-accent-primary mt-1" onClick={() => void refresh()}>{t('stream.hdrRecheck')}</button>}
  </div>;
}
