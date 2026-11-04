import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { usePortalContainer } from '../../hooks/usePortalContainer';
import { useFormatters } from '../../i18n/formatters';
import { isElectron } from '../../platform/platform';
import { useNativeHdrStore } from '../../stores/nativeHdrStore';
import { useNativeSdrStore } from '../../stores/nativeSdrStore';
import { useVoiceStore } from '../../stores/voiceStore';
import {
  cloneStreamColor,
  DEFAULT_CHANNEL_CURVE,
  DEFAULT_STREAM_COLOR,
  isChannelModified,
  isDefaultStreamColor,
  type ColorChannelCurve,
  type ColorChannelKey,
  type StreamColorSettings,
} from '../../utils/streamColor';

const CHANNEL_TABS: readonly {
  key: ColorChannelKey;
  labelKey:
    | 'voice:streamSettings.colorChannels.channel.all'
    | 'voice:streamSettings.colorChannels.channel.red'
    | 'voice:streamSettings.colorChannels.channel.green'
    | 'voice:streamSettings.colorChannels.channel.blue';
  dotClass: string;
}[] = [
  { key: 'all', labelKey: 'voice:streamSettings.colorChannels.channel.all', dotClass: 'bg-txt-primary' },
  { key: 'red', labelKey: 'voice:streamSettings.colorChannels.channel.red', dotClass: 'bg-accent-rose' },
  { key: 'green', labelKey: 'voice:streamSettings.colorChannels.channel.green', dotClass: 'bg-accent-mint' },
  { key: 'blue', labelKey: 'voice:streamSettings.colorChannels.channel.blue', dotClass: 'bg-accent-sky' },
];

const sliderClassName =
  'w-full h-1.5 rounded-full appearance-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ' +
  '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 ' +
  '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent-primary [&::-webkit-slider-thumb]:shadow-md ' +
  '[&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:border-0 ' +
  '[&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full ' +
  '[&::-moz-range-thumb]:bg-accent-primary [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer';

function sliderTrackStyle(value: number, min: number, max: number): React.CSSProperties {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return {
    background: `linear-gradient(to right, rgb(var(--accent-primary)) 0%, rgb(var(--accent-primary)) ${pct}%, rgb(var(--interactive-muted)) ${pct}%, rgb(var(--interactive-muted)) 100%)`,
  };
}

export function StreamColorControls() {
  const { t } = useTranslation(['voice', 'common']);
  const f = useFormatters();
  const id = useId();
  const portalContainer = usePortalContainer();

  const hdrEnabled = useVoiceStore((s) => s.screenShareConfig.hdrEnabled);
  const hdrExposureEv = useVoiceStore((s) => s.screenShareConfig.hdrExposureEv);
  const sdrExposureEv = useVoiceStore((s) => s.screenShareConfig.sdrExposureEv ?? 0);
  const storedStreamColor = useVoiceStore((s) => s.screenShareConfig.streamColor);
  const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);
  const setConfig = useVoiceStore((s) => s.setScreenShareConfig);

  const {
    colorControl,
    pendingColor,
    colorError,
    setColor: setHdrColor,
  } = useNativeHdrStore();
  const pendingSdrColor = useNativeSdrStore((s) => s.pendingColor);
  const sdrColorError = useNativeSdrStore((s) => s.colorError);

  const [expanded, setExpanded] = useState(false);
  const [activeChannel, setActiveChannel] = useState<ColorChannelKey>('all');
  const [infoOpen, setInfoOpen] = useState(false);

  const infoAnchorRef = useRef<HTMLButtonElement>(null);
  const infoPopoverRef = useRef<HTMLDivElement>(null);

  const { style: infoStyle } = useFloatingPosition(infoAnchorRef, infoPopoverRef, {
    placement: 'top',
    offset: 8,
    enabled: infoOpen,
  });

  useEffect(() => {
    if (!infoOpen) return;
    const handleOutside = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (infoAnchorRef.current?.contains(target) || infoPopoverRef.current?.contains(target)) return;
      setInfoOpen(false);
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('touchstart', handleOutside, { passive: true });
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('touchstart', handleOutside);
    };
  }, [infoOpen]);

  const showSdrExposure = !hdrEnabled && isElectron() && window.backspace?.platform === 'win32';
  const effectiveColor: StreamColorSettings =
    hdrEnabled && pendingColor
      ? pendingColor.streamColor
      : !hdrEnabled && pendingSdrColor
        ? pendingSdrColor.streamColor
        : (storedStreamColor ?? DEFAULT_STREAM_COLOR);
  const effectiveExposureEv =
    hdrEnabled && pendingColor ? pendingColor.exposureEv : hdrExposureEv;
  const effectiveSdrExposureEv =
    !hdrEnabled && pendingSdrColor ? pendingSdrColor.exposureEv : sdrExposureEv;

  const controlsDisabled = hdrEnabled && isScreenSharing && !colorControl;
  const modified = !isDefaultStreamColor(effectiveColor) || (showSdrExposure && effectiveSdrExposureEv !== 0);
  const activeCurve: ColorChannelCurve = effectiveColor[activeChannel];

  const applySdrColorAndExposure = (nextExposureEv: number, nextColor: StreamColorSettings) => {
    setConfig({ sdrExposureEv: nextExposureEv, streamColor: nextColor });
    if (useNativeSdrStore.getState().active) {
      useNativeSdrStore.getState().setColor({ exposureEv: nextExposureEv, streamColor: nextColor });
    }
  };

  const applyStreamColor = (next: StreamColorSettings) => {
    if (hdrEnabled) {
      setHdrColor({ exposureEv: effectiveExposureEv, streamColor: next });
    } else {
      applySdrColorAndExposure(effectiveSdrExposureEv, next);
    }
  };

  const updateSdrExposure = (nextEv: number) => {
    const rounded = Math.round(nextEv * 10) / 10;
    applySdrColorAndExposure(rounded, cloneStreamColor(effectiveColor));
  };

  const updateChannelCurve = (patch: Partial<ColorChannelCurve>) => {
    const next = cloneStreamColor(effectiveColor);
    next[activeChannel] = { ...next[activeChannel], ...patch };
    applyStreamColor(next);
  };

  const updateGlobalColor = (patch: Pick<Partial<StreamColorSettings>, 'digitalVibrance' | 'hue'>) => {
    const next = cloneStreamColor(effectiveColor);
    if (patch.digitalVibrance !== undefined) next.digitalVibrance = patch.digitalVibrance;
    if (patch.hue !== undefined) next.hue = patch.hue;
    applyStreamColor(next);
  };

  const resetAll = () => {
    const defaultColor = cloneStreamColor(DEFAULT_STREAM_COLOR);
    if (hdrEnabled) {
      applyStreamColor(defaultColor);
    } else {
      applySdrColorAndExposure(0, defaultColor);
    }
  };

  return (
    <div className="rounded-lg bg-surface-elevated/40 border border-border-hard">
      <div className="flex items-center justify-between gap-1.5 px-2.5 py-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={`${id}-panel`}
            onClick={() => setExpanded((prev) => !prev)}
            className="flex items-center gap-1.5 text-left text-[12px] font-semibold text-txt-primary hover:text-white transition-colors min-w-0"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="currentColor"
              className={`flex-shrink-0 text-txt-tertiary transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
            >
              <path d="M9.29 6.71a1 1 0 0 0 0 1.41L13.17 12l-3.88 3.88a1 1 0 1 0 1.41 1.41l4.59-4.59a1 1 0 0 0 0-1.41L10.7 6.7a1 1 0 0 0-1.41.01z" />
            </svg>
            <span className="truncate">{t('voice:streamSettings.colorChannels.title')}</span>
          </button>

          <button
            ref={infoAnchorRef}
            type="button"
            aria-label={t('voice:streamSettings.colorChannels.infoAria')}
            aria-describedby={infoOpen ? `${id}-info-tip` : undefined}
            onMouseEnter={() => setInfoOpen(true)}
            onMouseLeave={() => setInfoOpen(false)}
            onFocus={() => setInfoOpen(true)}
            onBlur={() => setInfoOpen(false)}
            onClick={() => setInfoOpen((prev) => !prev)}
            className="flex-shrink-0 text-txt-tertiary hover:text-txt-secondary transition-colors p-0.5 rounded-full"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
            </svg>
          </button>

          {modified && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-accent-primary/15 text-accent-primary flex-shrink-0">
              {t('voice:streamSettings.colorChannels.modified')}
            </span>
          )}
        </div>

        {modified && (
          <button
            type="button"
            disabled={controlsDisabled}
            onClick={resetAll}
            className="text-[11px] font-medium text-accent-primary hover:underline disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
          >
            {t('voice:streamSettings.colorChannels.reset')}
          </button>
        )}
      </div>

      {infoOpen &&
        createPortal(
          <div
            ref={infoPopoverRef}
            id={`${id}-info-tip`}
            role="tooltip"
            style={infoStyle}
            className="z-[60] max-w-[240px] px-3 py-2 text-[11px] leading-relaxed text-txt-primary glass rounded-md shadow-lg pointer-events-none"
          >
            {t('voice:streamSettings.colorChannels.infoHint')}
          </div>,
          portalContainer,
        )}

      {expanded && (
        <fieldset
          id={`${id}-panel`}
          disabled={controlsDisabled}
          className="px-2.5 pb-3 pt-1 border-t border-border-hard space-y-3"
        >
          {showSdrExposure && (
            <div className="space-y-1.5 pt-1">
              <label
                htmlFor={`${id}-sdr-exposure`}
                className="flex items-center justify-between text-[12px] text-txt-secondary"
              >
                <span>{t('voice:streamSettings.colorChannels.exposure')}</span>
                <span className="text-[11px] font-medium text-txt-primary tabular-nums">
                  {t('voice:streamSettings.colorChannels.evValue', {
                    value: `${effectiveSdrExposureEv > 0 ? '+' : ''}${effectiveSdrExposureEv.toFixed(1)}`,
                  })}
                </span>
              </label>
              <input
                id={`${id}-sdr-exposure`}
                aria-label={t('voice:streamSettings.colorChannels.exposure')}
                type="range"
                min={-3}
                max={3}
                step={0.1}
                value={effectiveSdrExposureEv}
                onChange={(e) => updateSdrExposure(Number(e.target.value))}
                onDoubleClick={() => updateSdrExposure(0)}
                className={sliderClassName}
                style={sliderTrackStyle(effectiveSdrExposureEv, -3, 3)}
              />
            </div>
          )}

          {/* Channel selector buttons */}
          <div className="grid grid-cols-4 gap-1 pt-1">
            {CHANNEL_TABS.map((item) => {
              const selected = activeChannel === item.key;
              const channelDirty = isChannelModified(effectiveColor[item.key]);
              return (
                <button
                  key={item.key}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setActiveChannel(item.key)}
                  className={`relative px-1.5 py-1 rounded border text-[11px] font-medium transition-colors select-none text-center truncate ${
                    selected
                      ? 'bg-white/[0.12] border-white/30 text-txt-primary'
                      : 'bg-surface-elevated/60 border-white/10 text-txt-secondary hover:bg-interactive-hover hover:text-txt-primary'
                  }`}
                >
                  {t(item.labelKey)}
                  {channelDirty && (
                    <span
                      aria-hidden="true"
                      className={`absolute top-1 right-1 w-1.5 h-1.5 rounded-full ${item.dotClass}`}
                    />
                  )}
                </button>
              );
            })}
          </div>

          {/* Per-channel: Brightness */}
          <div className="space-y-1.5">
            <label
              htmlFor={`${id}-brightness`}
              className="flex items-center justify-between text-[12px] text-txt-secondary"
            >
              <span>{t('voice:streamSettings.colorChannels.brightness')}</span>
              <span className="text-[11px] font-medium text-txt-primary tabular-nums">
                {t('common:units.percent', { value: f.formatNumber(activeCurve.brightness) })}
              </span>
            </label>
            <input
              id={`${id}-brightness`}
              aria-label={t('voice:streamSettings.colorChannels.brightness')}
              type="range"
              min={0}
              max={100}
              step={1}
              value={activeCurve.brightness}
              onChange={(e) => updateChannelCurve({ brightness: Number(e.target.value) })}
              onDoubleClick={() => updateChannelCurve({ brightness: DEFAULT_CHANNEL_CURVE.brightness })}
              className={sliderClassName}
              style={sliderTrackStyle(activeCurve.brightness, 0, 100)}
            />
          </div>

          {/* Per-channel: Contrast */}
          <div className="space-y-1.5">
            <label
              htmlFor={`${id}-contrast`}
              className="flex items-center justify-between text-[12px] text-txt-secondary"
            >
              <span>{t('voice:streamSettings.colorChannels.contrast')}</span>
              <span className="text-[11px] font-medium text-txt-primary tabular-nums">
                {t('common:units.percent', { value: f.formatNumber(activeCurve.contrast) })}
              </span>
            </label>
            <input
              id={`${id}-contrast`}
              aria-label={t('voice:streamSettings.colorChannels.contrast')}
              type="range"
              min={0}
              max={100}
              step={1}
              value={activeCurve.contrast}
              onChange={(e) => updateChannelCurve({ contrast: Number(e.target.value) })}
              onDoubleClick={() => updateChannelCurve({ contrast: DEFAULT_CHANNEL_CURVE.contrast })}
              className={sliderClassName}
              style={sliderTrackStyle(activeCurve.contrast, 0, 100)}
            />
          </div>

          {/* Per-channel: Gamma (灰度) */}
          <div className="space-y-1.5">
            <label
              htmlFor={`${id}-gamma`}
              className="flex items-center justify-between text-[12px] text-txt-secondary"
            >
              <span>{t('voice:streamSettings.colorChannels.gamma')}</span>
              <span className="text-[11px] font-medium text-txt-primary tabular-nums">
                {activeCurve.gamma.toFixed(2)}
              </span>
            </label>
            <input
              id={`${id}-gamma`}
              aria-label={t('voice:streamSettings.colorChannels.gamma')}
              type="range"
              min={0.3}
              max={2.8}
              step={0.01}
              value={activeCurve.gamma}
              onChange={(e) => updateChannelCurve({ gamma: Math.round(Number(e.target.value) * 100) / 100 })}
              onDoubleClick={() => updateChannelCurve({ gamma: DEFAULT_CHANNEL_CURVE.gamma })}
              className={sliderClassName}
              style={sliderTrackStyle(activeCurve.gamma, 0.3, 2.8)}
            />
          </div>

          <div className="border-t border-border-hard pt-2" />

          {/* Global: Digital Vibrance (%) */}
          <div className="space-y-1.5">
            <label
              htmlFor={`${id}-vibrance`}
              className="flex items-center justify-between text-[12px] text-txt-secondary"
            >
              <span>{t('voice:streamSettings.colorChannels.digitalVibrance')}</span>
              <span className="text-[11px] font-medium text-txt-primary tabular-nums">
                {t('common:units.percent', { value: f.formatNumber(effectiveColor.digitalVibrance) })}
              </span>
            </label>
            <input
              id={`${id}-vibrance`}
              aria-label={t('voice:streamSettings.colorChannels.digitalVibrance')}
              type="range"
              min={0}
              max={100}
              step={1}
              value={effectiveColor.digitalVibrance}
              onChange={(e) => updateGlobalColor({ digitalVibrance: Number(e.target.value) })}
              onDoubleClick={() => updateGlobalColor({ digitalVibrance: DEFAULT_STREAM_COLOR.digitalVibrance })}
              className={sliderClassName}
              style={sliderTrackStyle(effectiveColor.digitalVibrance, 0, 100)}
            />
          </div>

          {/* Global: Hue (°) */}
          <div className="space-y-1.5">
            <label
              htmlFor={`${id}-hue`}
              className="flex items-center justify-between text-[12px] text-txt-secondary"
            >
              <span>{t('voice:streamSettings.colorChannels.hue')}</span>
              <span className="text-[11px] font-medium text-txt-primary tabular-nums">
                {t('voice:streamSettings.colorChannels.degreeValue', {
                  value: f.formatNumber(effectiveColor.hue),
                })}
              </span>
            </label>
            <input
              id={`${id}-hue`}
              aria-label={t('voice:streamSettings.colorChannels.hue')}
              type="range"
              min={0}
              max={359}
              step={1}
              value={effectiveColor.hue}
              onChange={(e) => updateGlobalColor({ hue: Number(e.target.value) })}
              onDoubleClick={() => updateGlobalColor({ hue: DEFAULT_STREAM_COLOR.hue })}
              className={sliderClassName}
              style={sliderTrackStyle(effectiveColor.hue, 0, 359)}
            />
          </div>

          {controlsDisabled && (
            <p className="text-[10px] text-accent-amber">{t('voice:streamSettings.hdrColorUnsupported')}</p>
          )}
          {hdrEnabled && colorError && (
            <p className="text-xs text-accent-rose" role="alert">
              {t('voice:streamSettings.hdrColorFailed')}
            </p>
          )}
          {!hdrEnabled && sdrColorError && (
            <p className="text-xs text-accent-rose" role="alert">
              {t('voice:streamSettings.sdrColorFailed')}
            </p>
          )}
        </fieldset>
      )}
    </div>
  );
}
