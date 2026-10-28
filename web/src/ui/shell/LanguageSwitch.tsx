import { useT } from '../../i18n';
import { useLocale } from '../../i18n/LocaleProvider';
import { ENDONYMS, LOCALES, type Locale } from '../../i18n/locale';

export interface LanguageSwitchProps {
  locale: Locale;
  /** Accessible name of the group ("Language"). */
  label: string;
  onLocale: (locale: Locale) => void;
}

/**
 * ES | EN as two toggle buttons. The visible code is the accessible name;
 * `lang` makes screen readers say it right and the tooltip names the language.
 */
export function LanguageSwitch({ locale, label, onLocale }: LanguageSwitchProps) {
  return (
    <div class="segmented language-switch" role="group" aria-label={label}>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={l === locale}
          title={ENDONYMS[l]}
          onClick={() => onLocale(l)}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

/** The switch wired to the app's language. */
export function CurrentLanguageSwitch() {
  const { locale, setLocale } = useLocale();
  return <LanguageSwitch locale={locale} label={useT().shell.language} onLocale={setLocale} />;
}
