import { useEffect, useState } from 'preact/hooks';
import { useT } from '../../i18n';
import { useLocale } from '../../i18n/LocaleProvider';
import { ENDONYMS } from '../../i18n/locale';
import { MENU_LOCALES } from './AccountMenu';
import { LAYOUTS, onPrefsChange, readPrefs, writePrefs, type Prefs } from '../../shell/prefs';
import type { Theme } from '../../shell/theme';
import { Modal } from './Modal';
import { ThemeSwitch } from './ThemeSwitch';

export interface PreferencesDialogProps {
  open: boolean;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onClose: () => void;
}

const MODES = ['default', 'writing', 'code'] as const;

/**
 * Preferences of this browser. Sections for features that are not built yet
 * (notifications) stay out until they exist.
 */
export function PreferencesDialog({ open, theme, onTheme, onClose }: PreferencesDialogProps) {
  const t = useT();
  const m = t.preferences;
  const { locale, setLocale } = useLocale();
  const [auto, setAuto] = useState(() => readPrefs().autoCompile ?? false);
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  // The header's Writing | Code control writes the same preference.
  useEffect(() => onPrefsChange(setPrefs), []);
  const update = (change: Partial<Prefs>) => {
    const next: Prefs = { ...readPrefs(), ...change };
    if (next.editorMode === undefined) delete next.editorMode;
    setPrefs(next);
    writePrefs(next);
  };
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
        <div class="prefs-row">
          <span id="prefs-mode">{m.editorMode}</span>
          <div class="segmented" role="radiogroup" aria-labelledby="prefs-mode">
            {MODES.map((choice) => (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={(prefs.editorMode ?? 'default') === choice}
                onClick={() => update({ editorMode: choice === 'default' ? undefined : choice })}
              >
                {choice === 'default' ? m.paperDefault : t.editor[choice]}
              </button>
            ))}
          </div>
        </div>
        <p class="muted prefs-hint">{m.editorModeHint}</p>
        <label class="switch-row" title={m.vimHint}>
          <input
            type="checkbox"
            role="switch"
            class="switch"
            checked={prefs.vim === true}
            onChange={(e) => update({ vim: e.currentTarget.checked })}
          />
          <span>{m.vim}</span>
        </label>
        <p class="muted prefs-hint">{m.vimHint}</p>
        <label class="switch-row" title={t.writing.spellcheckHint}>
          <input
            type="checkbox"
            role="switch"
            class="switch"
            checked={prefs.spellcheck !== false}
            onChange={(e) => update({ spellcheck: e.currentTarget.checked })}
          />
          <span>{t.writing.spellcheck}</span>
        </label>
        <p class="muted prefs-hint">{t.writing.spellcheckHint}</p>
        <label class="switch-row" title={m.serverDraftsHint}>
          <input
            type="checkbox"
            role="switch"
            class="switch"
            checked={prefs.serverDrafts !== false}
            onChange={(e) => update({ serverDrafts: e.currentTarget.checked })}
          />
          <span>{m.serverDrafts}</span>
        </label>
        <p class="muted prefs-hint">{m.serverDraftsHint}</p>
      </section>
      <section class="prefs-section" aria-labelledby="prefs-view">
        <h3 id="prefs-view">{t.view.title}</h3>
        <div class="prefs-row">
          <span id="prefs-layout">{t.view.layout}</span>
          <div class="segmented" role="radiogroup" aria-labelledby="prefs-layout">
            {LAYOUTS.map((choice) => (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={(prefs.layout ?? 'both') === choice}
                onClick={() => update({ layout: choice })}
              >
                {t.view.layouts[choice]}
              </button>
            ))}
          </div>
        </div>
        <p class="muted prefs-hint">{t.view.layoutHint}</p>
        <label class="switch-row" title={t.view.focusHint}>
          <input
            type="checkbox"
            role="switch"
            class="switch"
            checked={prefs.focus === true}
            onChange={(e) => update({ focus: e.currentTarget.checked })}
          />
          <span>{t.view.focus}</span>
        </label>
        <p class="muted prefs-hint">{t.view.focusHint}</p>
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
