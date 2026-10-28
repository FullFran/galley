import { parseBibtex, type CslName } from '../render/bibtex';
import { dirname, resolvePath } from '../render/source';
import { citationsOf, type Citation } from '../references/citations';
import { paperWords, type PaperWords } from '../writing/words';

// What the editor knows about the whole paper: bibliography entries and
// crossref labels from every file, with where each one is defined. It feeds
// autocomplete, the inline warnings and "go to definition". Everything here
// is plain text scanning; repository content is never executed.

export interface IndexInput {
  /** Text of the paper's .qmd, .md and .bib files (open buffers win). */
  files: { path: string; text: string }[];
  /** Every repository path, for path completion. */
  paths: string[];
  /** Entry document; numbering follows its includes. */
  entry?: string;
}

export interface BibEntry {
  key: string;
  author?: string;
  year?: string;
  title?: string;
  path: string;
  /** 1-based line of the `@type{key,` header. */
  line: number;
}

export type LabelKind = 'fig' | 'tbl' | 'eq' | 'sec';

export interface LabelDef {
  id: string;
  kind: LabelKind;
  /** "2", "1.3"; undefined for files the entry document does not include. */
  number?: string;
  caption?: string;
  path: string;
  line: number;
}

export interface ProjectIndex {
  bib: BibEntry[];
  labels: LabelDef[];
  paths: string[];
  entry?: string;
  /** Where each bibliography key is cited (references manager). */
  cites?: Citation[];
  /** Word counts of the paper (Outline and header). */
  words?: PaperWords;
}

export const EMPTY_INDEX: ProjectIndex = { bib: [], labels: [], paths: [] };

const MAX_DEPTH = 16;
const INCLUDE = /\{\{<\s*include\s+["']?([^\s"'>]+)["']?\s*>\}\}/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*(.*)$/;
const LABEL_ATTR = /\{[^{}]*#((?:fig|tbl|eq|sec)-[\w:.-]*[\w])[^{}]*\}/g;

export const isText = (path: string) => /\.(qmd|md|markdown)$/i.test(path);
export const isBib = (path: string) => /\.bib$/i.test(path);

/** Resolves an include target the way the renderer does: next to the including file, then from the root. */
export function resolveInclude(from: string, raw: string, known: ReadonlySet<string>): string | undefined {
  return [resolvePath(dirname(from), raw), resolvePath('', raw)].find((p) => p !== undefined && known.has(p));
}

function mainEntry(input: IndexInput, texts: Map<string, string>): string | undefined {
  if (input.entry && texts.has(input.entry)) return input.entry;
  return ['index.qmd', 'index.md'].find((p) => texts.has(p));
}

const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, '$2');

export function buildIndex(input: IndexInput): ProjectIndex {
  const texts = new Map(input.files.map((f) => [f.path, f.text]));
  const known = new Set(input.paths.length ? input.paths : texts.keys());
  const labels: LabelDef[] = [];
  const seen = new Set<string>();
  const sections = [0, 0, 0, 0, 0, 0];
  const items = { fig: 0, tbl: 0, eq: 0 };
  const scanned = new Set<string>();

  const add = (def: Omit<LabelDef, 'number'>, numbered: boolean, level?: number) => {
    let number: string | undefined;
    if (numbered) {
      if (def.kind === 'sec' && level !== undefined) number = sections.slice(0, level).join('.');
      else if (def.kind !== 'sec') number = String(++items[def.kind]);
    }
    if (seen.has(def.id)) return;
    seen.add(def.id);
    labels.push(number === undefined ? def : { ...def, number });
  };

  const scan = (path: string, numbered: boolean, stack: string[]) => {
    scanned.add(path);
    const lines = (texts.get(path) ?? '').split('\n');
    let fence: string | undefined;
    let cell: { label?: string; line: number; caption?: string } | undefined;
    let frontMatter = lines[0]?.trim() === '---';
    lines.forEach((text, i) => {
      const line = i + 1;
      if (frontMatter) {
        if (i > 0 && /^(---|\.\.\.)\s*$/.test(text)) frontMatter = false;
        return;
      }
      const marker = FENCE.exec(text);
      if (fence) {
        if (marker && marker[1]?.[0] === fence[0] && (marker[1]?.length ?? 0) >= fence.length && !marker[2]) {
          fence = undefined;
          if (cell?.label && /^(fig|tbl)-/.test(cell.label)) {
            add({ id: cell.label, kind: cell.label.slice(0, 3) as LabelKind, caption: cell.caption, path, line: cell.line }, numbered);
          }
          cell = undefined;
        } else if (cell) {
          const opt = /^#\|\s*([\w-]+)\s*:\s*(.*)$/.exec(text);
          if (opt?.[1] === 'label') cell = { ...cell, label: unquote(opt[2] ?? ''), line };
          else if (opt && (opt[1] === 'fig-cap' || opt[1] === 'tbl-cap')) cell.caption = unquote(opt[2] ?? '');
        }
        return;
      }
      if (marker) {
        fence = marker[1];
        cell = marker[2]?.startsWith('{') ? { line } : undefined;
        return;
      }

      // Includes are numbered where they appear.
      for (const m of text.matchAll(INCLUDE)) {
        const target = resolveInclude(path, m[1] ?? '', known);
        if (!target || !texts.has(target) || stack.includes(target) || stack.length >= MAX_DEPTH) continue;
        scan(target, numbered, [...stack, target]);
      }

      const heading = /^(#{1,6})\s+(.*?)\s*(\{[^{}]*\})?\s*$/.exec(text);
      if (heading) {
        const level = heading[1]?.length ?? 1;
        const attrs = heading[3] ?? '';
        const unnumbered = /(^|\s)(\.unnumbered|-)(\s|\})/.test(attrs.replace('{', '{ '));
        if (numbered && !unnumbered) {
          sections[level - 1] = (sections[level - 1] ?? 0) + 1;
          sections.fill(0, level);
        }
        const id = /#(sec-[\w:.-]*[\w])/.exec(attrs)?.[1];
        if (id) add({ id, kind: 'sec', caption: heading[2], path, line }, numbered && !unnumbered, level);
        return;
      }

      for (const m of text.matchAll(LABEL_ATTR)) {
        const id = m[1] ?? '';
        const kind = id.slice(0, id.indexOf('-')) as LabelKind;
        const before = text.slice(0, m.index);
        let caption: string | undefined;
        if (kind === 'fig') caption = /!\[([^\]]*)\]\([^)]*\)\s*$/.exec(before)?.[1];
        else if (kind === 'tbl') caption = /^:\s+(.*?)\s*$/.exec(before)?.[1];
        add({ id, kind, caption: caption || undefined, path, line }, numbered && kind !== 'sec');
      }
    });
  };

  const entry = mainEntry(input, texts);
  if (entry) scan(entry, true, [entry]);
  for (const path of [...texts.keys()].filter(isText).sort()) if (!scanned.has(path)) scan(path, false, [path]);

  const bib = [...texts.entries()]
    .filter(([path]) => isBib(path))
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([path, text]) => bibEntries(path, text));

  const cites = citationsOf(input.files);
  const words = paperWords(texts, entry, (from, raw) => resolveInclude(from, raw, known));
  return { bib, labels, paths: [...known], entry, cites, words };
}

function authors(names: unknown): string | undefined {
  if (!Array.isArray(names) || names.length === 0) return undefined;
  const name = (n: CslName) => n.family ?? n.literal ?? n.given ?? '';
  const list = names as CslName[];
  if (list.length === 1) return name(list[0] as CslName);
  if (list.length === 2) return `${name(list[0] as CslName)} & ${name(list[1] as CslName)}`;
  return `${name(list[0] as CslName)} et al.`;
}

const plain = (html: unknown) =>
  typeof html === 'string'
    ? html
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
    : undefined;

function bibEntries(path: string, text: string): BibEntry[] {
  const { items } = parseBibtex(text);
  const lines = new Map<string, number>();
  const header = /@\s*([A-Za-z]+)\s*[{(]\s*([^,\s{}()]+)\s*,/g;
  for (const m of text.matchAll(header)) {
    const key = m[2] ?? '';
    if (/^(string|comment|preamble)$/i.test(m[1] ?? '') || lines.has(key)) continue;
    lines.set(key, text.slice(0, m.index).split('\n').length);
  }
  return Object.values(items).map((item) => {
    const year = (item.issued as { 'date-parts'?: unknown[][] } | undefined)?.['date-parts']?.[0]?.[0];
    const entry: BibEntry = { key: item.id, path, line: lines.get(item.id) ?? 1 };
    const author = authors(item.author ?? item.editor);
    if (author) entry.author = author;
    if (year !== undefined) entry.year = String(year);
    const title = plain(item.title);
    if (title) entry.title = title;
    return entry;
  });
}
