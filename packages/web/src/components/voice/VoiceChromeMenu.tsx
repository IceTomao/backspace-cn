import React, { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { usePortalContainer } from '../../hooks/usePortalContainer';
import { CONTEXT_MENU_SURFACE_ATTR } from '../../stores/contextMenuStore';
import { useVoiceStore } from '../../stores/voiceStore';
import type { VoiceFullscreenChrome } from '../../utils/voiceFullscreenChrome';

interface ChromeRow {
  key: keyof VoiceFullscreenChrome;
  labelKey: string;
  descriptionKey?: string;
}

/**
 * Each row hides one overlay instead of the panel offering presets: the useful
 * combination depends on what the call is being used for, so the user says
 * exactly which piece of chrome is in the way.
 */
const CHROME_ROWS = [
  {
    key: 'fillViewport',
    labelKey: 'voice:fullscreenChrome.fillViewport',
    descriptionKey: 'voice:fullscreenChrome.fillViewportHint',
  },
  { key: 'hideHeader', labelKey: 'voice:fullscreenChrome.hideHeader' },
  { key: 'hideLiveBadge', labelKey: 'voice:fullscreenChrome.hideLiveBadge' },
  { key: 'hideQualityBadge', labelKey: 'voice:fullscreenChrome.hideQualityBadge' },
  { key: 'hideCaption', labelKey: 'voice:fullscreenChrome.hideCaption' },
  {
    key: 'hideControlBar',
    labelKey: 'voice:fullscreenChrome.hideControlBar',
    descriptionKey: 'voice:fullscreenChrome.hideControlBarHint',
  },
] as const satisfies readonly ChromeRow[];

interface VoiceChromeMenuProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

export function VoiceChromeMenu({ open, onClose, anchorRef }: VoiceChromeMenuProps) {
  const { t } = useTranslation(['voice', 'common']);
  const menuRef = useRef<HTMLDivElement>(null);
  const portalContainer = usePortalContainer();
  const chrome = useVoiceStore((s) => s.fullscreenChrome);
  const setFullscreenChrome = useVoiceStore((s) => s.setFullscreenChrome);
  const resetFullscreenChrome = useVoiceStore((s) => s.resetFullscreenChrome);

  const { style } = useFloatingPosition(anchorRef, menuRef, {
    placement: 'top',
    offset: 12,
    enabled: open,
    // Above the call bar (z-20) and any stream-tile context menu (z-400).
    zIndex: 401,
  });

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      // The anchor toggles the panel itself; closing on its mousedown would
      // turn the following click into a re-open.
      if (anchorRef.current?.contains(target)) return;
      if (menuRef.current && !menuRef.current.contains(target)) onClose();
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  const anyHidden = CHROME_ROWS.some((row) => chrome[row.key]);

  return createPortal(
    <div
      ref={menuRef}
      style={style}
      className="w-[268px] glass rounded-lg overflow-hidden flex flex-col"
      {...{ [CONTEXT_MENU_SURFACE_ATTR]: '' }}
    >
      <div className="px-3 py-2 border-b border-border-hard flex items-center justify-between gap-2 flex-shrink-0">
        <div className="min-w-0">
          <div className="text-[14px] font-bold text-txt-primary">{t('voice:fullscreenChrome.title')}</div>
          <div className="text-[11px] text-txt-tertiary truncate">{t('voice:fullscreenChrome.hint')}</div>
        </div>
        <button
          type="button"
          onClick={resetFullscreenChrome}
          disabled={!anyHidden}
          className="text-[11px] text-txt-tertiary hover:text-txt-primary transition-colors disabled:opacity-40 disabled:hover:text-txt-tertiary flex-shrink-0"
        >
          {t('voice:fullscreenChrome.reset')}
        </button>
      </div>

      <div className="px-2 py-2 flex flex-col gap-0.5">
        {CHROME_ROWS.map((row) => {
          const hidden = chrome[row.key];
          const descriptionKey = 'descriptionKey' in row ? row.descriptionKey : null;
          return (
            <button
              key={row.key}
              type="button"
              role="switch"
              aria-checked={hidden}
              aria-label={t(row.labelKey)}
              onClick={() => setFullscreenChrome({ [row.key]: !hidden })}
              className="flex items-start gap-2.5 px-2 py-1.5 rounded-md text-left hover:bg-white/[0.05] transition-colors"
            >
              <span
                aria-hidden="true"
                className={`mt-0.5 w-8 h-[18px] rounded-full flex-shrink-0 relative transition-colors ${hidden ? 'bg-accent-primary' : 'bg-white/15'}`}
              >
                <span
                  className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-all ${hidden ? 'left-[16px]' : 'left-[2px]'}`}
                />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] text-txt-secondary leading-tight">{t(row.labelKey)}</span>
                {descriptionKey && (
                  <span className="block text-[11px] text-txt-tertiary leading-tight mt-0.5">
                    {t(descriptionKey)}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>,
    portalContainer,
  );
}
