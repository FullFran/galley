// CODEOWNERS: who owns which files, as GitHub reads it
// (docs.github.com, "About code owners"):
//   - the first file found in `.github/`, the root, then `docs/` is used;
//   - patterns follow most gitignore rules; `!`, `[ ]` and `\#` do not work;
//   - the last matching pattern wins; a pattern without owners un-owns;
//   - a line with invalid syntax is skipped;
//   - owners need explicit write access, or GitHub ignores them.
// Matching works segment by segment without regular expressions built from
// the file, in polynomial time, so a hostile CODEOWNERS cannot stall the page.

import { LOGIN } from '../shell/route';

export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const;
/** Where galley creates the file when the repository has none. */
export const NEW_CODEOWNERS_PATH = '.github/CODEOWNERS';
export const MAX_CODEOWNERS_BYTES = 3 * 1024 * 1024;

export interface OwnerRule {
  pattern: string;
  /** `@login`, `@org/team` or an email address, as written. */
  owners: string[];
  /** 1-based line in the file. */
  line: number;
}

const TEAM = /^@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/[A-Za-z0-9_.-]{1,100}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{1,63}$/;

export function isOwner(token: string): boolean {
  if (token.startsWith('@')) return LOGIN.test(token.slice(1)) || TEAM.test(token);
  return EMAIL.test(token);
}

export function isUserOwner(token: string): boolean {
  return token.startsWith('@') && LOGIN.test(token.slice(1));
}

/** The CODEOWNERS file GitHub uses, among the repository's files. */
export function codeownersPath(files: Iterable<string>): string | undefined {
  const set = new Set(files);
  return CODEOWNERS_PATHS.find((p) => set.has(p));
}

export function parseCodeowners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  text.split('\n').forEach((raw, i) => {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    const comment = tokens.findIndex((tok) => tok.startsWith('#'));
    const parts = comment >= 0 ? tokens.slice(0, comment) : tokens;
    const [pattern, ...owners] = parts;
    if (!pattern) return;
    if (pattern.startsWith('!') || /[[\]\\]/.test(pattern)) return;
    if (!owners.every(isOwner)) return;
    rules.push({ pattern, owners, line: i + 1 });
  });
  return rules;
}

/** Owners of a path: the last matching rule's, or none. */
export function ownersOf(rules: readonly OwnerRule[], path: string): string[] {
  for (let i = rules.length - 1; i >= 0; i -= 1) {
    const rule = rules[i];
    if (rule && matchesPattern(rule.pattern, path)) return [...rule.owners];
  }
  return [];
}

const hasWildcard = (seg: string) => seg.includes('*') || seg.includes('?');

/** A CODEOWNERS pattern against a repository file path. */
export function matchesPattern(pattern: string, path: string): boolean {
  let pat = pattern;
  const dirOnly = pat.endsWith('/');
  while (pat.endsWith('/')) pat = pat.slice(0, -1);
  if (pat === '') return false;
  // A slash at the start or in the middle anchors the pattern at the root.
  const anchored = pat.includes('/');
  while (pat.startsWith('/')) pat = pat.slice(1);
  const segs = pat.split('/');
  if (segs.some((s) => s === '')) return false;
  if (!anchored) segs.unshift('**');
  const parts = path.split('/');
  // A pattern naming a folder owns everything inside it; `docs/*` stays one level deep.
  const last = segs[segs.length - 1] ?? '';
  const prefixes = dirOnly || !hasWildcard(last);
  if (!dirOnly && matchSegments(segs, parts, parts.length)) return true;
  if (!prefixes) return false;
  for (let k = parts.length - 1; k >= 1; k -= 1) if (matchSegments(segs, parts, k)) return true;
  return false;
}

/** `segs` against the first `n` parts. */
function matchSegments(segs: string[], parts: string[], n: number): boolean {
  const width = n + 1;
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * width + j;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (i === segs.length) result = j === n;
    else if (segs[i] === '**' && i === segs.length - 1) result = j < n;
    else if (segs[i] === '**') result = go(i + 1, j) || (j < n && go(i, j + 1));
    else result = j < n && matchSegment(segs[i] ?? '', parts[j] ?? '') && go(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

function matchSegment(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let star = -1;
  let mark = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === name[n])) {
      p += 1;
      n += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      mark = n;
      p += 1;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      n = mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/** True when galley can write a rule for exactly this file. */
export function isWritablePath(path: string): boolean {
  return path !== '' && !/[\s*?[\]\\!#]/.test(path) && !path.startsWith('/') && !path.split('/').some((s) => s === '' || s === '.' || s === '..');
}

const HEADER = '# Section owners, edited from galley. GitHub asks them to review changes.\n# Owners need write access to the repository; GitHub skips anyone else.\n';

/**
 * Sets the owners of one file: replaces its exact `/path` rule, or appends one
 * at the end (so it wins over broader rules). No owners removes the exact rules.
 * Undefined when an owner or the path cannot be written.
 */
export function setOwners(text: string, path: string, owners: readonly string[]): string | undefined {
  if (!isWritablePath(path) || !owners.every(isOwner)) return undefined;
  const pattern = `/${path}`;
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const isRule = (line: string) => line.trim().split(/\s+/)[0] === pattern;
  const rule = owners.length > 0 ? `${pattern} ${owners.join(' ')}` : undefined;
  let out: string[];
  if (!rule) out = lines.filter((l) => !isRule(l));
  else {
    const at = lines.map(isRule).lastIndexOf(true);
    out = [...lines];
    if (at >= 0) out[at] = rule;
    else out.push(rule);
  }
  const body = out.length > 0 ? `${out.join('\n')}\n` : '';
  return text.trim() === '' && rule ? `${HEADER}${body}` : body;
}
