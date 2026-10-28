import type { Diagnostic, ProjectSource } from './index';

/** Splits a leading YAML front matter block from the Markdown body. */
export function splitFrontMatter(text: string): { yaml?: string; body: string } {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { body: text };
  return { yaml: m[1], body: text.slice(m[0].length) };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Where a line of an expanded document comes from (1-based line). */
export interface Origin {
  path: string;
  line: number;
}

/** Text with the origin of each of its lines (`origins.length` is its line count). */
export interface Mapped {
  text: string;
  origins: Origin[];
}

/** Offsets of each line start. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Builds text from slices of mapped sources, keeping each line's origin. */
class MappedBuilder {
  text = '';
  origins: Origin[] = [];

  append(piece: Mapped) {
    if (piece.text === '') return;
    const [first, ...rest] = piece.origins;
    if (this.origins.length === 0 || this.text.endsWith('\n')) {
      // The current last line is empty: it takes the origin of what starts it.
      if (this.origins.length > 0) this.origins.pop();
      if (first) this.origins.push(first);
    }
    for (const o of rest) this.origins.push(o);
    this.text += piece.text;
  }

  result(fallback: Origin): Mapped {
    return { text: this.text, origins: this.origins.length ? this.origins : [fallback] };
  }
}

/** A slice of a mapped text, with the origins of the lines it touches. */
function sliceMapped(source: Mapped, starts: number[], from: number, to: number): Mapped {
  if (to <= from) return { text: '', origins: [] };
  return { text: source.text.slice(from, to), origins: source.origins.slice(lineAt(starts, from), lineAt(starts, to) + 1) };
}

function plainMapped(text: string, path: string, firstLine: number): Mapped {
  return { text, origins: lineStarts(text).map((_, i) => ({ path, line: firstLine + i })) };
}

/** Comment ranges `<!-- ... -->` within from..to, in one linear pass; an unclosed comment stays as text. */
function commentRanges(text: string, from: number, to: number, out: [number, number][]) {
  let pos = from;
  for (;;) {
    const open = text.indexOf('<!--', pos);
    if (open < 0 || open >= to) return;
    const close = text.indexOf('-->', open + 4);
    if (close < 0 || close + 3 > to) return;
    out.push([open, close + 3]);
    pos = close + 3;
  }
}

/** The kept parts of `text`: everything but HTML comments outside fenced code. */
function commentFreeSegments(text: string): [number, number][] {
  const removed: [number, number][] = [];
  let fence: string | undefined;
  let proseStart: number | undefined;
  let pos = 0;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const end = nl < 0 ? text.length : nl;
    const line = text.slice(pos, end);
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
    } else if (marker) {
      if (proseStart !== undefined) commentRanges(text, proseStart, Math.max(proseStart, pos - 1), removed);
      proseStart = undefined;
      fence = marker;
    } else proseStart ??= pos;
    if (nl < 0) break;
    pos = nl + 1;
  }
  if (proseStart !== undefined) commentRanges(text, proseStart, text.length, removed);
  const kept: [number, number][] = [];
  let last = 0;
  for (const [a, b] of removed) {
    kept.push([last, a]);
    last = b;
  }
  kept.push([last, text.length]);
  return kept;
}

function stripCommentsMapped(source: Mapped): Mapped {
  const starts = lineStarts(source.text);
  const out = new MappedBuilder();
  for (const [a, b] of commentFreeSegments(source.text)) out.append(sliceMapped(source, starts, a, b));
  return out.result(source.origins[0] ?? { path: '', line: 1 });
}

/**
 * Removes HTML comments outside fenced code. Comments carry authors' notes
 * (sources, TODOs) and are never part of the output.
 */
export function stripComments(text: string): string {
  return commentFreeSegments(text)
    .map(([a, b]) => text.slice(a, b))
    .join('');
}

/** Joins and normalizes a repository path; undefined when it leaves the repository. */
export function resolvePath(dir: string, path: string): string | undefined {
  const parts = path.startsWith('/') ? [] : dir.split('/').filter(Boolean);
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

const MAX_DEPTH = 16;
/** Limits that keep an include fan-out (a includes b twice, b includes c twice...) bounded. */
export const MAX_INCLUDES = 500;
export const MAX_EXPANDED_LENGTH = 8 * 1024 * 1024;

interface Shortcode {
  start: number;
  end: number;
  name: string;
  args: string;
  /** `{{{< x >}}}`, Quarto's escape for a literal shortcode. */
  escaped: boolean;
}

/** Finds `{{< name args >}}` shortcodes with indexOf, in linear time. */
function* shortcodes(text: string): Generator<Shortcode> {
  let pos = 0;
  for (;;) {
    let open = text.indexOf('{{<', pos);
    if (open < 0) return;
    const close = text.indexOf('>}}', open + 3);
    // Without a closing marker after this opening, no later one has one either.
    if (close < 0) return;
    // Use the opening nearest to the close, so `{{< a {{< b >}}` is one shortcode `b`.
    open = text.lastIndexOf('{{<', close);
    pos = close + 3;
    const inner = text.slice(open + 3, close);
    const m = /^\s*([\w-]+)\s*/.exec(inner);
    if (!m?.[1]) continue;
    const escaped = text[open - 1] === '{' && text[close + 3] === '}';
    yield {
      start: escaped ? open - 1 : open,
      end: escaped ? close + 4 : close + 3,
      name: m[1],
      args: inner.slice(m[0].length).trim(),
      escaped,
    };
    if (escaped) pos = close + 4;
  }
}

interface Budget {
  includes: number;
  length: number;
  reported: Set<string>;
}

/**
 * Expands `{{< include path >}}` recursively. Paths are relative to the
 * including file (falling back to the project root); cycles and missing
 * files become diagnostics, and the number of includes and the expanded
 * length are capped. Comments are stripped from every file first, so a
 * commented-out include is ignored.
 */
export async function expandIncludes(text: string, path: string, project: ProjectSource, diagnostics: Diagnostic[]): Promise<string> {
  return (await expandIncludesMapped(text, path, 1, project, diagnostics)).text;
}

/**
 * `expandIncludes` that also says which file and line each output line comes
 * from (`firstLine`: the line of `text` in `path`, after any front matter).
 */
export function expandIncludesMapped(
  text: string,
  path: string,
  firstLine: number,
  project: ProjectSource,
  diagnostics: Diagnostic[],
): Promise<Mapped> {
  return expand(plainMapped(text, path, firstLine), path, project, diagnostics, [path], {
    includes: 0,
    length: text.length,
    reported: new Set(),
  });
}

/** The line of `whole` on which `body` (its tail, after the front matter) starts. */
export const bodyFirstLine = (whole: string, body: string) => lineStarts(whole.slice(0, whole.length - body.length)).length;

async function expand(
  raw: Mapped,
  path: string,
  project: ProjectSource,
  diagnostics: Diagnostic[],
  stack: string[],
  budget: Budget,
): Promise<Mapped> {
  const mapped = stripCommentsMapped(raw);
  const source = mapped.text;
  const starts = lineStarts(source);
  const known = new Set(project.files);
  const once = (key: string, message: string) => {
    if (budget.reported.has(key)) return;
    budget.reported.add(key);
    diagnostics.push({ severity: 'warning', path, message });
  };
  const out = new MappedBuilder();
  let last = 0;
  for (const code of shortcodes(source)) {
    if (code.escaped || code.name !== 'include') continue;
    out.append(sliceMapped(mapped, starts, last, code.start));
    last = code.end;
    const rawPath = code.args.replace(/^["']|["']$/g, '');
    const candidates = [resolvePath(dirname(path), rawPath), resolvePath('', rawPath)];
    const target = candidates.find((c) => c !== undefined && known.has(c));
    if (!target) {
      diagnostics.push({ severity: 'warning', path, message: `Included file not found: ${rawPath}` });
      continue;
    }
    if (stack.includes(target)) {
      diagnostics.push({ severity: 'warning', path, message: `Include cycle skipped: ${[...stack, target].join(' → ')}` });
      continue;
    }
    if (stack.length >= MAX_DEPTH) {
      once('depth', `Includes nested more than ${MAX_DEPTH} levels deep are not shown (${target}).`);
      continue;
    }
    if (budget.includes >= MAX_INCLUDES) {
      once('count', `Too many includes (more than ${MAX_INCLUDES}); the rest are not shown in the preview.`);
      continue;
    }
    budget.includes++;
    let included: string;
    try {
      included = await project.readText(target);
    } catch {
      diagnostics.push({ severity: 'warning', path, message: `Could not read included file ${target}` });
      continue;
    }
    const body = splitFrontMatter(included).body;
    if (budget.length + body.length > MAX_EXPANDED_LENGTH) {
      once('length', 'The document is too long to preview in full; some includes are not shown.');
      continue;
    }
    budget.length += body.length;
    const child = plainMapped(body, target, bodyFirstLine(included, body));
    out.append(await expand(child, target, project, diagnostics, [...stack, target], budget));
  }
  out.append(sliceMapped(mapped, starts, last, source.length));
  return out.result(mapped.origins[0] ?? { path, line: 1 });
}

/**
 * Removes the shortcodes that remain after includes are expanded. `{{{< x >}}}`
 * is Quarto's escape for a literal shortcode.
 */
export function removeShortcodes(text: string, diagnostics: Diagnostic[]): string {
  return removeShortcodesMapped(plainMapped(text, '', 1), diagnostics).text;
}

/** `removeShortcodes` keeping the origin of each line. */
export function removeShortcodesMapped(source: Mapped, diagnostics: Diagnostic[]): Mapped {
  const text = source.text;
  const starts = lineStarts(text);
  const reported = new Set<string>();
  const out = new MappedBuilder();
  let last = 0;
  for (const code of shortcodes(text)) {
    out.append(sliceMapped(source, starts, last, code.start));
    last = code.end;
    if (code.escaped) {
      out.append(sliceMapped(source, starts, code.start + 1, code.end - 1));
      continue;
    }
    if (code.name !== 'pagebreak' && !reported.has(code.name)) {
      reported.add(code.name);
      diagnostics.push({ severity: 'info', message: `The {{< ${code.name} >}} shortcode is not shown in the preview.` });
    }
  }
  out.append(sliceMapped(source, starts, last, text.length));
  return out.result(source.origins[0] ?? { path: '', line: 1 });
}
