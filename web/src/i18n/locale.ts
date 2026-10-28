import { en, type Messages } from './en';
import { es } from './es';

// The interface language: chosen in the switcher and remembered in this
// browser, else taken from the browser's language, else English.

export const LOCALES = ['es', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_KEY = 'galley-locale';

export const CATALOGS: Record<Locale, Messages> = { es, en };

/** Each language named in itself, for the switcher's accessible names. */
export const ENDONYMS: Record<Locale, string> = { es: 'Español', en: 'English' };

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;
type HtmlDocument = { documentElement: { lang: string } };

const isLocale = (value: unknown): value is Locale => LOCALES.includes(value as Locale);

/** `window.localStorage`, or undefined where reading it throws (privacy modes, sandboxed frames). */
export function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

export function readStoredLocale(storage: ReadStorage | undefined): Locale | undefined {
  try {
    const value = storage?.getItem(LOCALE_KEY);
    return isLocale(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Stored choice, else the first browser language if it is Spanish, else English. */
export function detectLocale(
  storage: ReadStorage | undefined = browserStorage(),
  languages: readonly string[] | undefined = browserLanguages(),
): Locale {
  const stored = readStoredLocale(storage);
  if (stored) return stored;
  return languages?.[0]?.toLowerCase().startsWith('es') ? 'es' : 'en';
}

/** Remembers the choice; a storage failure only means it is not remembered. */
export function storeLocale(locale: Locale, storage: WriteStorage | undefined = browserStorage()): void {
  try {
    storage?.setItem(LOCALE_KEY, locale);
  } catch {
    // Not remembered in this browser; the page still switches.
  }
}

export function syncHtmlLang(locale: Locale, doc: HtmlDocument | undefined = typeof document === 'undefined' ? undefined : document): void {
  if (doc) doc.documentElement.lang = locale;
}

/** What a switch does besides re-rendering: remember it and update `<html lang>`. */
export function applyLocale(locale: Locale, env: { storage?: WriteStorage; doc?: HtmlDocument } = {}): void {
  // Missing parts fall back to the browser's own (default parameters).
  storeLocale(locale, env.storage);
  syncHtmlLang(locale, env.doc);
}
