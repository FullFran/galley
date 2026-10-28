import type { Diagnostic, ProjectSource } from './index';

/** Splits a leading YAML front matter block from the Markdown body. */
export function splitFrontMatter(text: string): { yaml?: string; body: string } {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { body: text };
  return { yaml: m[1], body: text.slice(m[0].length) };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Drops `<!-- ... -->` in one linear pass; an unclosed comment stays as text. */
function removeComments(text: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const open = text.indexOf('<!--', pos);
    if (open < 0) break;
    const close = text.indexOf('-->', open + 4);
    if (close < 0) break;
    out += text.slice(pos, open);
    pos = close + 3;
  }
  return out + text.slice(pos);
}

/**
 * Removes HTML comments outside fenced code. Comments carry authors' notes
 * (sources, TODOs) and are never part of the output.
 */
export function stripComments(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let prose: string[] = [];
  let fence: string | undefined;
  const flush = () => {
    if (prose.length) out.push(removeComments(prose.join('\n')));
    prose = [];
  };
  for (const line of lines) {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
    } else if (marker) {
      flush();
      fence = marker;
      out.push(line);
    } else prose.push(line);
  }
  flush();
  return out.join('\n');
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
export async function expandIncludes(
  text: string,
  path: string,
  project: ProjectSource,
  diagnostics: Diagnostic[],
  stack: string[] = [path],
  budget: Budget = { includes: 0, length: text.length, reported: new Set() },
): Promise<string> {
  const source = stripComments(text);
  const known = new Set(project.files);
  const once = (key: string, message: string) => {
    if (budget.reported.has(key)) return;
    budget.reported.add(key);
    diagnostics.push({ severity: 'warning', path, message });
  };
  let out = '';
  let last = 0;
  for (const code of shortcodes(source)) {
    if (code.escaped || code.name !== 'include') continue;
    out += source.slice(last, code.start);
    last = code.end;
    const raw = code.args.replace(/^["']|["']$/g, '');
    const candidates = [resolvePath(dirname(path), raw), resolvePath('', raw)];
    const target = candidates.find((c) => c !== undefined && known.has(c));
    if (!target) {
      diagnostics.push({ severity: 'warning', path, message: `Included file not found: ${raw}` });
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
    out += await expandIncludes(body, target, project, diagnostics, [...stack, target], budget);
  }
  return out + source.slice(last);
}

/**
 * Removes the shortcodes that remain after includes are expanded. `{{{< x >}}}`
 * is Quarto's escape for a literal shortcode.
 */
export function removeShortcodes(text: string, diagnostics: Diagnostic[]): string {
  const reported = new Set<string>();
  let out = '';
  let last = 0;
  for (const code of shortcodes(text)) {
    out += text.slice(last, code.start);
    last = code.end;
    if (code.escaped) {
      out += text.slice(code.start + 1, code.end - 1);
      continue;
    }
    if (code.name !== 'pagebreak' && !reported.has(code.name)) {
      reported.add(code.name);
      diagnostics.push({ severity: 'info', message: `The {{< ${code.name} >}} shortcode is not shown in the preview.` });
    }
  }
  return out + text.slice(last);
}
