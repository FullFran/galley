/**
 * Picks the singular or plural form for a count with the language's own
 * plural rules (`Intl.PluralRules`), so 0 and 1 follow each language.
 */
export function plural(lang: string): (n: number, one: string, other: string) => string {
  const rules = new Intl.PluralRules(lang);
  return (n, one, other) => (rules.select(n) === 'one' ? one : other);
}
