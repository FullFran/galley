// Citation keys that follow the paper's own convention. The rule is detected
// from the existing keys (author, year and maybe the first title word, in
// some letter case and with some separator), and new keys follow it, with
// a, b, c… added when the key is taken.

export interface KeyRule {
  author: 'lower' | 'capital';
  /** Between the parts: '', '_', ':' or '-'. */
  sep: string;
  word: 'none' | 'lower' | 'capital';
}

export interface KeyFacts {
  /** Family name of the first author (or editor). */
  family?: string;
  year?: string;
  title?: string;
}

/** Google Scholar's `authorYEARword`, the most common convention. */
export const DEFAULT_RULE: KeyRule = { author: 'lower', sep: '', word: 'lower' };

const SEPARATORS = ['', '_', ':', '-'];
const RULES: KeyRule[] = SEPARATORS.flatMap((sep) =>
  (['lower', 'capital'] as const).flatMap((author) => (['none', 'lower', 'capital'] as const).map((word) => ({ author, sep, word }))),
);

const STOP = new Set(
  'a an the on of in for and to with from by at as is are its into about via towards toward using new el la los las un una de del en y con por para sobre le les des du et der die das ein eine und über zur zum il lo gli di e'.split(
    ' ',
  ),
);

const ascii = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[øØ]/g, 'o')
    .replace(/[łŁ]/g, 'l')
    .replace(/[æÆ]/g, 'ae');

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function namePart(family: string | undefined, mode: KeyRule['author']): string {
  const clean = ascii(family ?? '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toLowerCase();
  const name = clean || 'anon';
  return mode === 'capital' ? capital(name) : name;
}

function titleWord(title: string | undefined): string {
  for (const raw of ascii(title ?? '').split(/[^A-Za-z0-9]+/)) {
    const word = raw.toLowerCase();
    if (word && !STOP.has(word) && !/^\d+$/.test(word)) return word;
  }
  return '';
}

export function makeKey(rule: KeyRule, facts: KeyFacts): string {
  const parts = [namePart(facts.family, rule.author)];
  const year = /\d{4}/.exec(facts.year ?? '')?.[0];
  if (year) parts.push(year);
  if (rule.word !== 'none') {
    const word = titleWord(facts.title);
    if (word) parts.push(rule.word === 'capital' ? capital(word) : word);
  }
  return parts.join(rule.sep);
}

/** The rule most existing keys follow (a trailing a–z disambiguation letter is allowed), else the default. */
export function detectKeyRule(samples: (KeyFacts & { key: string })[]): KeyRule {
  const usable = samples.filter((s) => s.family || s.year);
  if (usable.length === 0) return DEFAULT_RULE;
  let best: KeyRule | undefined;
  let bestScore = 0;
  for (const rule of RULES) {
    let score = 0;
    for (const s of usable) {
      const expected = makeKey(rule, s);
      if (s.key === expected || (s.key.length === expected.length + 1 && s.key.startsWith(expected) && /[a-z]$/.test(s.key))) score++;
    }
    if (score > bestScore) [best, bestScore] = [rule, score];
  }
  return best && bestScore * 2 >= usable.length ? best : DEFAULT_RULE;
}

/** The rule written as an example: `author2020word`, `Author_2020`. */
export function keyExample(rule: KeyRule): string {
  const parts = [rule.author === 'capital' ? 'Author' : 'author', '2020'];
  if (rule.word !== 'none') parts.push(rule.word === 'capital' ? 'Word' : 'word');
  return parts.join(rule.sep);
}

/** `base`, else `basea`, `baseb`… (keys compare without case, as biber does). */
export function uniqueKey(base: string, taken: ReadonlySet<string>): string {
  const lower = new Set([...taken].map((k) => k.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let i = 0; i < 26 * 27; i++) {
    const suffix = i < 26 ? String.fromCharCode(97 + i) : String.fromCharCode(97 + Math.floor(i / 26) - 1) + String.fromCharCode(97 + (i % 26));
    if (!lower.has(`${base}${suffix}`.toLowerCase())) return `${base}${suffix}`;
  }
  return `${base}${Date.now()}`;
}
