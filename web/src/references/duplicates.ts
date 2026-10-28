import type { LibraryEntry } from './library';

// Duplicate keys (biber compares keys without case) and duplicate DOIs
// (compared without case, without a doi.org prefix).

export function normalizeDoiKey(doi: string): string {
  return doi
    .trim()
    .replace(/^doi:\s*/i, '')
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .toLowerCase();
}

export interface Duplicates {
  /** Lower-cased key → the entries that share it (two or more). */
  keys: Map<string, LibraryEntry[]>;
  /** Normalised DOI → the entries that share it (two or more). */
  dois: Map<string, LibraryEntry[]>;
}

function groups(entries: readonly LibraryEntry[], by: (e: LibraryEntry) => string | undefined): Map<string, LibraryEntry[]> {
  const all = new Map<string, LibraryEntry[]>();
  for (const e of entries) {
    const k = by(e);
    if (!k) continue;
    all.set(k, [...(all.get(k) ?? []), e]);
  }
  return new Map([...all].filter(([, list]) => list.length > 1));
}

export function duplicates(entries: readonly LibraryEntry[]): Duplicates {
  return {
    keys: groups(entries, (e) => e.key.toLowerCase()),
    dois: groups(entries, (e) => (e.doi ? normalizeDoiKey(e.doi) : undefined)),
  };
}

/** Another entry with this key; `except` is the key of the entry being edited (its first match is skipped). */
export function duplicateKey(entries: readonly LibraryEntry[], key: string, except?: string): LibraryEntry | undefined {
  let skipped = except === undefined;
  return entries.find((e) => {
    if (!skipped && e.key === except) {
      skipped = true;
      return false;
    }
    return e.key.toLowerCase() === key.toLowerCase();
  });
}

export function duplicateDoi(entries: readonly LibraryEntry[], doi: string, except?: string): LibraryEntry | undefined {
  const wanted = normalizeDoiKey(doi);
  if (!wanted) return undefined;
  return entries.find((e) => e.key !== except && e.doi !== undefined && normalizeDoiKey(e.doi) === wanted);
}
