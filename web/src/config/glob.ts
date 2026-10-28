// A small glob matcher for `.galley.yml` paths. Patterns are matched one
// folder name (segment) at a time:
//   *   any characters inside one folder name
//   ?   exactly one character inside one folder name
//   **  as a whole segment: zero or more folders
// Wildcards never match a name that starts with a dot, so `**` cannot reach
// `.galley.yml` or `.github/`; a dotted name must be written out.
// The matcher uses no regular expressions built from input and runs in
// polynomial time, so a hostile pattern cannot stall the page.

import { en, type Messages } from '../i18n/en';

export const MAX_PATTERN_LENGTH = 200;

/**
 * Why a pattern is not accepted, or undefined when it is fine. The text
 * continues a sentence such as "This pattern …"; `t` picks the language.
 */
export function globError(pattern: string, t: Messages = en): string | undefined {
  const m = t.glob;
  if (pattern === '') return m.empty;
  if (pattern.length > MAX_PATTERN_LENGTH) return m.tooLong(MAX_PATTERN_LENGTH);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(pattern)) return m.control;
  if (pattern.includes('\\')) return m.backslash;
  if (pattern.startsWith('/') || pattern.startsWith('~')) return m.absolute;
  if (/^[A-Za-z]:/.test(pattern)) return m.drive;
  if (/[[\]{}!]/.test(pattern)) return m.syntax;
  if (pattern.endsWith('/')) return m.trailingSlash;
  for (const seg of pattern.split('/')) {
    if (seg === '') return m.emptyFolder;
    if (seg === '..') return m.parent;
    if (seg === '.') return m.dot;
    if (seg.includes('**') && seg !== '**') return m.doubleStar;
  }
  return undefined;
}

/** True when the pattern has no wildcard, i.e. it names one file. */
export function isPlainPath(pattern: string): boolean {
  return !/[*?]/.test(pattern);
}

/** Matches a repository path against a pattern accepted by `globError`. */
export function matchGlob(pattern: string, path: string): boolean {
  const pat = pattern.split('/');
  const parts = path.split('/');
  // memo[i][j]: pattern from i matches path from j.
  const memo = new Map<number, boolean>();
  const width = parts.length + 1;
  const go = (i: number, j: number): boolean => {
    const key = i * width + j;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (i === pat.length) result = j === parts.length;
    else if (pat[i] === '**' && i === pat.length - 1) {
      // A trailing `**` matches everything inside the folder, but not the folder itself.
      result = j < parts.length && parts.slice(j).every((seg) => !seg.startsWith('.'));
    } else if (pat[i] === '**') {
      // Zero folders, or consume one non-dotted folder and stay on `**`.
      result = go(i + 1, j) || (j < parts.length && !(parts[j] ?? '').startsWith('.') && go(i, j + 1));
    } else result = j < parts.length && matchSegment(pat[i] ?? '', parts[j] ?? '') && go(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

/** True when any pattern matches the path. */
export function matchAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => matchGlob(p, path));
}

function matchSegment(pattern: string, name: string): boolean {
  if (name.startsWith('.') && !pattern.startsWith('.')) return false;
  // Iterative wildcard match with a single backtrack point: O(n * m) worst case.
  let p = 0;
  let n = 0;
  let star = -1;
  let mark = 0;
  while (n < name.length) {
    const c = pattern[p];
    if (c === '?' || (c !== undefined && c !== '*' && c === name[n])) {
      p++;
      n++;
    } else if (c === '*') {
      star = p++;
      mark = n;
    } else if (star >= 0) {
      p = star + 1;
      n = ++mark;
    } else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
