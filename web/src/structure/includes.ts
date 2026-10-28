import { dirname, resolvePath } from '../render/source';
import { extractOutline } from '../shell/outline';

// The entry document's `{{< include >}}` list, and the text edits that add a
// section (a new include line) or a subsection (a new heading). The include
// list is the paper's order; files are never renumbered or renamed.

export interface EntryInclude {
  /** As written in the entry file, relative to it. */
  raw: string;
  /** From the repository root. */
  path: string;
  /** 1-based line in the entry file. */
  line: number;
}

export interface IncludeStyle {
  quote: '' | '"' | "'";
  /** True when includes are separated by blank lines. */
  blankLines: boolean;
}

export type IncludeList = { includes: EntryInclude[]; style: IncludeStyle } | { error: 'unparseable' };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Line numbers (1-based) outside front matter and fenced code. */
function proseLines(lines: string[]): number[] {
  const out: number[] = [];
  let i = 0;
  if (lines[0]?.trimEnd() === '---') {
    const close = lines.findIndex((l, n) => n > 0 && (l.trimEnd() === '---' || l.trimEnd() === '...'));
    if (close > 0) i = close + 1;
  }
  let fence: string | undefined;
  for (; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const m = FENCE.exec(line);
    if (fence) {
      if (m?.[1] && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = undefined;
      continue;
    }
    if (m?.[1]) {
      fence = m[1];
      continue;
    }
    out.push(i + 1);
  }
  return out;
}

/**
 * The includes of the entry file, or `unparseable` when an include shortcode
 * sits somewhere galley cannot place a new line next to (inside a paragraph,
 * empty, or pointing outside the repository).
 */
export function readIncludes(entry: string, text: string): IncludeList {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const items = extractOutline(text).filter((i): i is Extract<typeof i, { kind: 'include' }> => i.kind === 'include');
  const at = new Set(items.map((i) => i.line));
  for (const n of proseLines(lines)) {
    const line = lines[n - 1] ?? '';
    const open = line.indexOf('{{<');
    if (open >= 0 && line.slice(open + 3).trimStart().startsWith('include') && !at.has(n)) return { error: 'unparseable' };
  }
  const includes: EntryInclude[] = [];
  for (const item of items) {
    const path = resolvePath(dirname(entry), item.path);
    if (path === undefined || path === '') return { error: 'unparseable' };
    includes.push({ raw: item.path, path, line: item.line });
  }
  const quoted = items.length > 0 ? /include\s+(["'])/.exec(lines[(items[0]?.line ?? 1) - 1] ?? '')?.[1] : undefined;
  const quote = quoted === '"' || quoted === "'" ? quoted : '';
  const first = items[0];
  const blankLines = first === undefined || items.length < 2 || (lines[first.line] ?? '').trim() === '';
  return { includes, style: { quote, blankLines } };
}

export function includeLine(raw: string, quote: IncludeStyle['quote']): string {
  return `{{< include ${quote}${raw}${quote} >}}`;
}

/**
 * Inserts an include of `raw` after the include on line `after`, or before the
 * first include (`start`). Without any include it goes at the end.
 */
export function insertInclude(text: string, raw: string, after: number | 'start', style: IncludeStyle): string {
  const lines = text.split('\n');
  const line = includeLine(raw, style.quote);
  const first = extractOutline(text).find((i) => i.kind === 'include');
  if (!first) {
    const body = text.replace(/\n+$/, '');
    return `${body}${body ? '\n\n' : ''}${line}\n`;
  }
  if (after === 'start') {
    const index = first.line - 1;
    lines.splice(index, 0, ...(style.blankLines ? [line, ''] : [line]));
  } else {
    lines.splice(after, 0, ...(style.blankLines ? ['', line] : [line]));
  }
  return lines.join('\n');
}

/**
 * Adds `Title {#id}` one level below the heading on `parentLine` (or below the
 * file's first heading), at the end of that heading's section, with blank
 * lines around it.
 */
export function insertSubsection(text: string, title: string, id: string, parentLine?: number): string {
  const headings = extractOutline(text).filter((i): i is Extract<typeof i, { kind: 'heading' }> => i.kind === 'heading');
  const parent = parentLine === undefined ? headings[0] : headings.find((h) => h.line === parentLine);
  const level = Math.min((parent?.level ?? 1) + 1, 6);
  const heading = `${'#'.repeat(level)} ${title} {#${id}}`;
  const next = parent ? headings.find((h) => h.line > parent.line && h.level <= parent.level) : undefined;
  if (!next) {
    const body = text.replace(/\n+$/, '');
    return `${body}${body ? '\n\n' : ''}${heading}\n`;
  }
  const lines = text.split('\n');
  const index = next.line - 1;
  const before = lines[index - 1]?.trim() === '' ? [] : [''];
  lines.splice(index, 0, ...before, heading, '');
  return lines.join('\n');
}
