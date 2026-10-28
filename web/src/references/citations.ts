import { CITE, citeKey, isCrossref, maskCode } from '../editor/refs';

// Where the paper cites a key: every `@key` outside front matter and code,
// one row per key and line, with the line's text for the warning before a
// delete. Plain text scanning, the same citation syntax as the editor.

export interface Citation {
  key: string;
  path: string;
  /** 1-based. */
  line: number;
  /** The line, trimmed and shortened. */
  text: string;
}

const MAX_TEXT = 160;
const MAX_CITATIONS = 20_000;

export function citationsOf(files: readonly { path: string; text: string }[]): Citation[] {
  const out: Citation[] = [];
  for (const { path, text } of files) {
    if (!/\.(qmd|md|markdown)$/i.test(path)) continue;
    const masked = maskCode(text).split('\n');
    const lines = text.split('\n');
    masked.forEach((line, i) => {
      const seen = new Set<string>();
      for (const m of line.matchAll(CITE)) {
        const key = citeKey(m[1] ?? '');
        if (!key || isCrossref(key) || seen.has(key)) continue;
        seen.add(key);
        if (out.length >= MAX_CITATIONS) return;
        const raw = (lines[i] ?? '').replace(/\r$/, '').trim();
        out.push({ key, path, line: i + 1, text: raw.length > MAX_TEXT ? `${raw.slice(0, MAX_TEXT - 1)}…` : raw });
      }
    });
  }
  return out;
}

export function findCitations(files: readonly { path: string; text: string }[], key: string): Omit<Citation, 'key'>[] {
  return citationsOf(files)
    .filter((c) => c.key === key)
    .map(({ path, line, text }) => ({ path, line, text }));
}
