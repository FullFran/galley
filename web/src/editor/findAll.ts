// Find and replace across the files of a repository. Pure functions over
// `{ path, text }`: the panel feeds them the open buffers and the repository
// text, and turns replacements into pending buffer edits (never commits).
// Regular expressions run in a worker (findRunner.ts) so a pattern that
// backtracks forever can be stopped.

export interface FindOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface FindMatch {
  /** Offsets in the file text. */
  from: number;
  to: number;
  /** 1-based line and 0-based column of `from`. */
  line: number;
  column: number;
  text: string;
  lineText: string;
  before: string[];
  after: string[];
}

export interface FileMatches {
  path: string;
  matches: FindMatch[];
}

export interface FindResult {
  files: FileMatches[];
  total: number;
  truncated: boolean;
  timedOut: boolean;
}

export const MAX_MATCHES = 2000;
const MAX_LINE_TEXT = 300;

export type Compiled = { ok: true; re: RegExp } | { ok: false; error: 'empty' | 'invalid' };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The global regular expression for the options; never throws. */
export function compileQuery(o: FindOptions): Compiled {
  if (!o.query) return { ok: false, error: 'empty' };
  const source = o.regex ? o.query : escapeRe(o.query);
  const flags = o.caseSensitive ? 'gm' : 'gmi';
  // Unicode mode first (letters of any script count for whole words); some
  // older-style patterns are only valid without it.
  try {
    return { ok: true, re: new RegExp(o.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source, `${flags}u`) };
  } catch {
    try {
      return { ok: true, re: new RegExp(o.wholeWord ? `(?<!\\w)(?:${source})(?!\\w)` : source, flags) };
    } catch {
      return { ok: false, error: 'invalid' };
    }
  }
}

const clip = (line: string) => (line.length > MAX_LINE_TEXT ? `${line.slice(0, MAX_LINE_TEXT)}…` : line);

export function findInFiles(
  files: readonly { path: string; text: string }[],
  o: FindOptions,
  { context = 1, maxMatches = MAX_MATCHES, deadline }: { context?: number; maxMatches?: number; deadline?: () => boolean } = {},
): FindResult {
  const result: FindResult = { files: [], total: 0, truncated: false, timedOut: false };
  const compiled = compileQuery(o);
  if (!compiled.ok) return result;
  const re = compiled.re;
  for (const file of files) {
    if (deadline?.()) return { ...result, timedOut: true };
    const { text } = file;
    let lines: string[] | undefined;
    let lineStarts: number[] | undefined;
    const matches: FindMatch[] = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[0] === '') {
        // An empty match: step over it (by code point) so the loop moves on.
        re.lastIndex = m.index + ((text.codePointAt(m.index) ?? 0) > 0xffff ? 2 : 1);
        if (m.index >= text.length) break;
        continue;
      }
      if (result.total >= maxMatches) {
        result.truncated = true;
        break;
      }
      if (deadline?.()) {
        if (matches.length) result.files.push({ path: file.path, matches });
        return { ...result, timedOut: true };
      }
      lines ??= text.split('\n');
      if (!lineStarts) {
        lineStarts = [0];
        let at = 0;
        for (const l of lines.slice(0, -1)) lineStarts.push((at += l.length + 1));
      }
      let li = 0;
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if ((lineStarts[mid] ?? 0) <= m.index) {
          li = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      const strip = (l: string) => clip(l.replace(/\r$/, ''));
      matches.push({
        from: m.index,
        to: m.index + m[0].length,
        line: li + 1,
        column: m.index - (lineStarts[li] ?? 0),
        text: m[0],
        lineText: strip(lines[li] ?? ''),
        before: lines.slice(Math.max(0, li - context), li).map(strip),
        after: lines.slice(li + 1, li + 1 + context).map(strip),
      });
      result.total++;
    }
    if (matches.length) result.files.push({ path: file.path, matches });
    if (result.truncated) break;
  }
  return result;
}

/** The replacement text for one match: `$1`, `$<name>`, `$&` and `$$` in regex mode, literal otherwise. */
export function expandReplacement(template: string, m: RegExpExecArray, regex: boolean): string {
  if (!regex) return template;
  return template.replace(/\$(\$|&|<([^>]*)>|(\d{1,2}))/g, (all, what: string, name: string | undefined, num: string | undefined) => {
    if (what === '$') return '$';
    if (what === '&') return m[0];
    if (name !== undefined) return m.groups?.[name] ?? '';
    const n = Number(num);
    if (n >= 1 && n < m.length) return m[n] ?? '';
    // `$12` with one group: `$1` followed by `2`.
    const one = Number(num?.[0]);
    if (num && num.length === 2 && one >= 1 && one < m.length) return `${m[one] ?? ''}${num[1]}`;
    return all;
  });
}

/**
 * Replaces the given matches in `text`. Each match is checked again at its
 * offset (the buffer may have changed since the search); those that moved
 * are counted as stale and left alone.
 */
export function replaceMatches(
  text: string,
  matches: readonly Pick<FindMatch, 'from' | 'to' | 'text'>[],
  o: FindOptions,
  replacement: string,
): { text: string; replaced: number; stale: number } {
  const compiled = compileQuery(o);
  if (!compiled.ok) return { text, replaced: 0, stale: matches.length };
  const sticky = new RegExp(compiled.re.source, compiled.re.flags.replace('g', '') + 'y');
  const edits: { from: number; to: number; insert: string }[] = [];
  let stale = 0;
  for (const match of [...matches].sort((a, b) => a.from - b.from)) {
    sticky.lastIndex = match.from;
    const m = sticky.exec(text);
    const overlaps = (edits[edits.length - 1]?.to ?? -1) > match.from;
    if (!m || m[0] !== match.text || m.index + m[0].length !== match.to || overlaps) {
      stale++;
      continue;
    }
    edits.push({ from: match.from, to: match.to, insert: expandReplacement(replacement, m, o.regex) });
  }
  let out = text;
  for (const e of [...edits].reverse()) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return { text: out, replaced: edits.length, stale };
}

export interface ReplaceStep {
  path: string;
  before: string;
  after: string;
}

/** What an undo restores: files still holding the replaced text; the rest changed since. */
export function undoable(steps: readonly ReplaceStep[], current: (path: string) => string | undefined) {
  const restore: { path: string; text: string }[] = [];
  const changed: string[] = [];
  for (const s of steps) {
    if (current(s.path) === s.after) restore.push({ path: s.path, text: s.before });
    else changed.push(s.path);
  }
  return { restore, changed };
}
