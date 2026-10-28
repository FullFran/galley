import { useState } from 'preact/hooks';
import { useT } from '../../i18n';
import { useLocale } from '../../i18n/LocaleProvider';
import { ENDONYMS } from '../../i18n/locale';
import { MENU_LOCALES } from './AccountMenu';
import { readPrefs, writePrefs } from '../../shell/prefs';
import type { Theme } from '../../shell/theme';
import { Modal } from './Modal';
import { ThemeSwitch } from './ThemeSwitch';

export interface PreferencesDialogProps {
  open: boolean;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onClose: () => void;
}

/**
 * Preferences of this browser. Sections for features that are not built yet
 * (Writing/Code mode, Vim, notifications) stay out until they exist.
 */
export function PreferencesDialog({ open, theme, onTheme, onClose }: PreferencesDialogProps) {
  const t = useT();
  const m = t.preferences;
  const { locale, setLocale } = useLocale();
  const [auto, setAuto] = useState(() => readPrefs().autoCompile ?? false);
  return (
    <Modal open={open} onClose={onClose} labelledBy="prefs-title" class="prefs-dialog">
      <h2 id="prefs-title">{m.title}</h2>
      <section class="prefs-section" aria-labelledby="prefs-editor">
        <h3 id="prefs-editor">{m.editor}</h3>
        <label class="switch-row" title={m.autoCompileHint}>
          <input
            type="checkbox"
            role="switch"
            class="switch"
            checked={auto}
            onChange={(e) => {
              const next = e.currentTarget.checked;
              setAuto(next);
              writePrefs({ ...readPrefs(), autoCompile: next });
            }}
          />
          <span>{m.autoCompile}</span>
        </label>
      </section>
      <section class="prefs-section" aria-labelledby="prefs-appearance">
        <h3 id="prefs-appearance">{m.appearance}</h3>
        <div class="prefs-row">
          <span>{t.shell.theme}</span>
          <ThemeSwitch theme={theme} onTheme={onTheme} />
        </div>
        <div class="prefs-row">
          <span>{t.shell.language}</span>
          <div class="segmented" role="radiogroup" aria-label={t.shell.language}>
            {MENU_LOCALES.map((l) => (
              <button key={l} type="button" role="radio" lang={l} aria-checked={locale === l} onClick={() => setLocale(l)}>
                {ENDONYMS[l]}
              </button>
            ))}
          </div>
        </div>
      </section>
      <div class="actions">
        <button type="button" class="primary" onClick={onClose}>
          {m.done}
        </button>
      </div>
    </Modal>
  );
}
