import type { EntryInclude } from './includes';

// How a paper names its section files, read from the entry's include list,
// so a new section looks like its siblings. Without includes galley uses
// `sections/_<slug>.qmd` (Quarto skips files starting with `_` when it
// renders a project, which suits included parts).

export interface Convention {
  /** Folder of new section files, from the repository root, with a trailing `/` (or empty for the root). */
  folder: string;
  /** Names start with `_`. */
  underscore: boolean;
  /** Names start with a number (`01-intro.qmd`); undefined when they do not. */
  numbered?: { width: number; sep: '-' | '_' };
  ext: '.qmd' | '.md';
}

const NUMBERED = /^(\d+)([a-z]?)([-_])/;
const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const folderOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);
const stripUnderscore = (name: string) => (name.startsWith('_') ? name.slice(1) : name);

function most<T>(values: T[], fallback: T): T {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = fallback;
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

export function detectConvention(_entry: string, includes: readonly EntryInclude[]): Convention {
  if (includes.length === 0) return { folder: 'sections/', underscore: true, ext: '.qmd' };
  const names = includes.map((i) => base(i.path));
  const folder = most(
    includes.map((i) => folderOf(i.path)),
    '',
  );
  const underscore = names.filter((n) => n.startsWith('_')).length * 2 > names.length;
  const ext = most(
    names.map((n) => (/\.md$/i.test(n) ? '.md' : '.qmd')),
    '.qmd' as const,
  );
  // Numbered only when most siblings are (two or more), so one "2020-notes" is not a convention.
  const matches = names.map((n) => NUMBERED.exec(stripUnderscore(n))).filter((m): m is RegExpExecArray => m !== null);
  const numbered =
    matches.length >= 2 && matches.length * 2 > names.length
      ? { width: most(matches.map((m) => m[1]?.length ?? 2), 2), sep: most<'-' | '_'>(matches.map((m) => (m[3] === '_' ? '_' : '-')), '-') }
      : undefined;
  return numbered ? { folder, underscore, numbered, ext } : { folder, underscore, ext };
}

interface Num {
  n: number;
  letter: string;
}

function numberOf(path: string | undefined): Num | undefined {
  if (!path) return undefined;
  const m = NUMBERED.exec(stripUnderscore(base(path)));
  return m ? { n: Number(m[1]), letter: m[2] ?? '' } : undefined;
}

const nextLetter = (letter: string) => (letter === '' ? 'a' : letter === 'z' ? undefined : String.fromCharCode(letter.charCodeAt(0) + 1));

/**
 * The path of a new section file. With numbered siblings the new file never
 * renumbers others: at the end it takes the next free number (`04-`), at the
 * start the one before the first (`00-`), and between two files a letter
 * after the previous number (`02a-`, then `02b-`), so the folder still lists
 * in paper order. Without a numeric convention a slug that starts with a digit
 * gets `section-` in front, so it does not look numbered.
 */
export function sectionPath(slug: string, conv: Convention, place: { prev?: string; next?: string }, existing: readonly string[]): string {
  const stem = slug || 'section';
  const lead = conv.underscore ? '_' : '';
  if (!conv.numbered) return `${conv.folder}${lead}${/^\d/.test(stem) ? `section-${stem}` : stem}${conv.ext}`;
  const { width, sep } = conv.numbered;
  const pad = (n: number) => String(n).padStart(width, '0');
  const used = new Set(
    existing
      .filter((p) => folderOf(p) === conv.folder)
      .map((p) => numberOf(p))
      .filter((x): x is Num => x !== undefined)
      .map((x) => `${pad(x.n)}${x.letter}`),
  );
  const prev = numberOf(place.prev);
  const next = numberOf(place.next);
  let prefix: string;
  if (!next) {
    const max = Math.max(-1, ...[...used].map((u) => Number(/^\d+/.exec(u)?.[0] ?? -1)), prev?.n ?? -1);
    prefix = pad(max + 1);
  } else if (!prev && next.n > 0 && !used.has(pad(next.n - 1))) {
    prefix = pad(next.n - 1);
  } else {
    const from = prev ?? { n: Math.max(0, next.n - 1), letter: '' };
    let letter = nextLetter(from.letter);
    while (letter && used.has(`${pad(from.n)}${letter}`)) letter = nextLetter(letter);
    prefix = `${pad(from.n)}${letter ?? 'z'}`;
  }
  return `${conv.folder}${lead}${prefix}${sep}${stem}${conv.ext}`;
}
