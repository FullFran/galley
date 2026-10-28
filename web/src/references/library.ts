import { parseBibtex, type CslName } from '../render/bibtex';
import { detectStyle, formatEntry, scanBib, type BibEntry, type EntryDraft } from './bibFile';
import type { KeyFacts } from './keys';

// The references of the paper as a list: every entry of every .bib file with
// readable authors, year and title (through the preview's BibTeX reader),
// plus search and sort for the references manager.

export interface LibraryEntry {
  key: string;
  type: string;
  path: string;
  authors: string;
  /** First author's (or editor's) family name, for keys. */
  family?: string;
  year: string;
  title: string;
  doi?: string;
  entry: BibEntry;
}

export type SortBy = 'key' | 'author' | 'year' | 'title';

const plain = (html: unknown) =>
  typeof html === 'string'
    ? html
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
    : '';

function names(list: unknown): { text: string; family?: string } {
  if (!Array.isArray(list) || list.length === 0) return { text: '' };
  const name = (n: CslName) => n.family ?? n.literal ?? n.given ?? '';
  const all = (list as CslName[]).map(name).filter(Boolean);
  const text = all.length <= 3 ? (all.length === 1 ? (all[0] ?? '') : `${all.slice(0, -1).join(', ')} & ${all[all.length - 1]}`) : `${all[0]} et al.`;
  return { text, family: all[0] };
}

export function readLibrary(files: readonly { path: string; text: string }[]): LibraryEntry[] {
  return files.flatMap(({ path, text }) => {
    const { items } = parseBibtex(text);
    const lower = new Map(Object.entries(items).map(([k, v]) => [k, v]));
    return scanBib(text).entries.map((entry) => {
      const item = lower.get(entry.key);
      const who = names(item?.author ?? item?.editor);
      const year = (item?.issued as { 'date-parts'?: unknown[][] } | undefined)?.['date-parts']?.[0]?.[0];
      const doiField = entry.fields.find((f) => f.name.toLowerCase() === 'doi')?.value.trim();
      const row: LibraryEntry = {
        key: entry.key,
        type: entry.type.toLowerCase(),
        path,
        authors: who.text,
        year: year === undefined ? '' : String(year),
        title: plain(item?.title),
        entry,
      };
      if (who.family) row.family = who.family;
      if (doiField) row.doi = doiField;
      return row;
    });
  });
}

const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Entries matching every word of the query in their key, authors, year, title or DOI. */
export function searchEntries(entries: readonly LibraryEntry[], query: string): LibraryEntry[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...entries];
  return entries.filter((e) => {
    const hay = fold([e.key, e.authors, e.year, e.title, e.doi ?? '', e.type].join(' '));
    return words.every((w) => hay.includes(w));
  });
}

/** Sorted copy; empty values go last; years newest first. */
export function sortEntries(entries: readonly LibraryEntry[], by: SortBy): LibraryEntry[] {
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const value = (e: LibraryEntry) => (by === 'key' ? e.key : by === 'author' ? e.authors : by === 'year' ? e.year : e.title);
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const va = value(a.e);
      const vb = value(b.e);
      if (!va !== !vb) return va ? -1 : 1;
      const order = by === 'year' ? collator.compare(vb, va) : collator.compare(va, vb);
      return order || a.i - b.i;
    })
    .map(({ e }) => e);
}

/** First author, year and title of a draft, read the way the preview reads them. */
export function draftFacts(draft: EntryDraft): KeyFacts {
  const text = formatEntry({ ...draft, key: 'k' }, detectStyle(''));
  const row = readLibrary([{ path: '', text }])[0];
  return { family: row?.family, year: row?.year || undefined, title: row?.title || undefined };
}
