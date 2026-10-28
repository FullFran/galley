import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useState } from 'preact/hooks';
import { I18n } from './index';
import { CATALOGS, applyLocale, detectLocale, syncHtmlLang, type Locale } from './locale';

export interface LocaleControl {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleControl>({ locale: 'en', setLocale: () => undefined });

export function useLocale(): LocaleControl {
  return useContext(LocaleContext);
}

/**
 * Owns the interface language. Switching re-renders the app with the other
 * catalog (no reload), remembers the choice and keeps `<html lang>` in sync.
 */
export function LocaleProvider({ initial, children }: { initial?: Locale; children: ComponentChildren }) {
  const [locale, setState] = useState<Locale>(() => initial ?? detectLocale());
  useEffect(() => syncHtmlLang(locale), [locale]);
  const setLocale = useCallback((next: Locale) => {
    applyLocale(next);
    setState(next);
  }, []);
  const control = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return (
    <LocaleContext.Provider value={control}>
      <I18n.Provider value={CATALOGS[locale]}>{children}</I18n.Provider>
    </LocaleContext.Provider>
  );
}
