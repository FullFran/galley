import { useState } from 'preact/hooks';
import { useT } from '../../i18n';
import { applyTheme, readTheme, THEMES, writeTheme, type Theme } from '../../shell/theme';

/** The theme choice shared by the account menu and Preferences: stored, applied to <html>. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const choose = (next: Theme) => {
    setTheme(next);
    writeTheme(next);
    if (typeof document !== 'undefined') applyTheme(document.documentElement, next);
  };
  return [theme, choose];
}

/** System · Light · Dark as a radio group (Preferences). Arrow keys move between options. */
export function ThemeSwitch({ theme, onTheme }: { theme: Theme; onTheme: (theme: Theme) => void }) {
  const t = useT();
  const move = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = THEMES[(THEMES.indexOf(theme) + step + THEMES.length) % THEMES.length] ?? 'system';
    onTheme(next);
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-value="${next}"]`)?.focus();
  };
  return (
    <div class="segmented" role="radiogroup" aria-label={t.shell.theme} onKeyDown={move}>
      {THEMES.map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          data-value={value}
          aria-checked={theme === value}
          tabIndex={theme === value ? 0 : -1}
          onClick={() => onTheme(value)}
        >
          {t.theme[value]}
        </button>
      ))}
    </div>
  );
}
