// Theme choice: System (follow the OS), Light or Dark. Light and Dark set
// `data-theme` on <html>, which styles.css honours; System removes it so
// `prefers-color-scheme` decides. public/theme-init.js applies the stored
// choice before first paint (an external file: CSP `script-src 'self'`).

export type Theme = 'system' | 'light' | 'dark';

export const THEMES: readonly Theme[] = ['system', 'light', 'dark'];
export const THEME_KEY = 'galley:theme';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function local(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readTheme(store: Pick<Storage, 'getItem'> | undefined = local()): Theme {
  try {
    const value = store?.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function writeTheme(theme: Theme, store: Store | undefined = local()): void {
  try {
    if (theme === 'system') store?.removeItem(THEME_KEY);
    else store?.setItem(THEME_KEY, theme);
  } catch {
    // Not remembered; the theme still changes for this visit.
  }
}

export function applyTheme(root: { dataset: DOMStringMap | Record<string, string | undefined> }, theme: Theme): void {
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}
