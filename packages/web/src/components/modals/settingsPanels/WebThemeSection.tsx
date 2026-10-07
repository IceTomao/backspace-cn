import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getWebThemeMode, setWebThemeMode, type ThemeMode } from '../../../platform/webTheme';

const modes: ThemeMode[] = ['system', 'light', 'dark'];

export function WebThemeSection() {
  const { t } = useTranslation('settings');
  const [mode, setMode] = useState<ThemeMode>(getWebThemeMode);
  return <fieldset className="space-y-2">
    <legend className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
      {t('appearance.theme')}
    </legend>
    <div className="rounded-lg bg-surface-elevated border border-border-soft p-3.5">
      <div className="grid grid-cols-3 gap-1 rounded-md bg-surface-input p-1" role="radiogroup" aria-label={t('appearance.theme')}>
        {modes.map(value => <button
          key={value}
          type="button"
          role="radio"
          aria-checked={mode === value}
          onClick={() => { setMode(value); setWebThemeMode(value); }}
          className={`min-h-9 rounded px-2 text-sm transition-colors ${mode === value ? 'bg-surface-chat text-txt-primary shadow-sm' : 'text-txt-secondary hover:bg-interactive-hover'}`}
        >{t(`appearance.themeMode.${value}`)}</button>)}
      </div>
    </div>
  </fieldset>;
}
