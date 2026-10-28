import type { WordLimits } from '../config/schema';

// Word counts of the paper, per section and in total, the way a journal's
// word limit reads them: prose only. Not counted: YAML front matter (except
// the abstract, which is counted on its own), code blocks and inline code,
// math, bracketed citations `[@key]`, figures (image markup with its
// caption), HTML comments, shortcodes, attributes `{#id .class}`, div fences
// and URLs. A narrative citation or crossref (`@key`, `@fig-x`) counts as one
// word. A section titled "Abstract" (or `{.abstract}`) counts as the abstract.
// Line-by-line scanning with simple patterns; repository text is never run.

export interface SectionWords {
  /** 1-based line of the heading. */
  line: number;
  level: number;
  /** Words of the section, its subsections and the files it includes. */
  words: number;
}

export interface FileWords {
  /** Words per line (index 0 is line 1), abstract sections excluded. */
  lines: number[];
  headings: { line: number; level: number; abstract: boolean }[];
  includes: { line: number; path: string }[];
  /** Front matter `abstract:` plus "Abstract" sections. */
  abstract: number;
  /** Lines of "Abstract" sections, counted as abstract (1-based, inclusive). */
  abstractRanges: [number, number][];
  /** This file alone. */
  total: number;
  /** This file alone; included files are added by `paperWords`. */
  sections: SectionWords[];
}

const WORD = /[\p{L}\p{N}]+(?:[’'.,-][\p{L}\p{N}]+)*/gu;

export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

const INCLUDE = /^\s*\{\{<\s*include\s+["']?([^\s"'>]+)["']?\s*>\}\}\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Prose of one line with markup, math, citations and figures taken out. */
function prose(line: string): string {
  return (
    line
      .replace(/(`+)[^`]*?\1/g, ' ')
      .replace(/\{\{<[\s\S]*?>\}\}/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\$\$[^$]*\$\$/g, ' ')
      .replace(/(?<![\\$])\$(?!\s)[^$\n]*?[^\s\\]\$(?!\d)/g, ' ')
      .replace(/(?<![\\$])\$(?!\s)[^\s$\\]\$/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)(\{[^}]*\})?/g, ' ')
      .replace(/\[[^\]]*@[^\]]*\]/g, ' ')
      .replace(/\[\^[^\]]*\]/g, ' ')
      .replace(/\{[#.][^}]*\}|\{[^}]*=[^}]*\}/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<https?:[^>]*>|https?:\/\/\S+/g, ' ')
      .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
      .replace(/\\[A-Za-z]+\*?/g, ' ')
      // A narrative citation or crossref reads as one word.
      .replace(/(?<![\w@./\\])-?@[\w][\w:.#$%&\-+?<>~/]*[\w]/g, ' cite ')
  );
}

function headingOf(line: string): { level: number; abstract: boolean } | undefined {
  const m = /^(#{1,6})[ \t]+(.*?)[ \t]*(\{[^{}]*\})?[ \t]*$/.exec(line);
  if (!m) return undefined;
  const title = (m[2] ?? '').replace(/#+$/, '').trim();
  const attrs = m[3] ?? '';
  return { level: m[1]?.length ?? 1, abstract: /^abstract$/i.test(title) || /(^|[\s{])\.abstract(?=[\s}])/.test(attrs) };
}

/** The `abstract:` of a YAML front matter block (block scalar or inline). */
function frontMatterAbstract(lines: string[]): string {
  const at = lines.findIndex((l) => /^abstract:/.test(l));
  if (at < 0) return '';
  const value = (lines[at] ?? '').slice('abstract:'.length).trim();
  if (/^[|>][+-]?\d*$/.test(value)) {
    const body: string[] = [];
    for (let i = at + 1; i < lines.length; i++) {
      const l = lines[i] ?? '';
      if (l.trim() !== '' && !/^\s/.test(l)) break;
      body.push(l);
    }
    return body.join('\n');
  }
  return value.replace(/^(["'])([\s\S]*)\1$/, '$2');
}

export function countFileWords(text: string): FileWords {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const words = new Array<number>(lines.length).fill(0);
  const headings: FileWords['headings'] = [];
  const includes: FileWords['includes'] = [];
  let abstract = 0;
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((l, n) => n > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (close > 0) {
      const yamlAbstract = frontMatterAbstract(lines.slice(1, close));
      abstract += countWords(yamlAbstract.split('\n').map(prose).join('\n'));
      i = close + 1;
    }
  }
  let fence: string | undefined;
  let comment = false;
  let math = false;
  let latex: string | undefined;
  for (; i < lines.length; i++) {
    let line = lines[i] ?? '';
    if (fence) {
      const m = FENCE.exec(line)?.[1];
      if (m && m[0] === fence[0] && m.length >= fence.length && line.trim() === m) fence = undefined;
      continue;
    }
    if (latex) {
      if (line.includes(`\\end{${latex}}`)) latex = undefined;
      continue;
    }
    if (comment) {
      const end = line.indexOf('-->');
      if (end < 0) continue;
      comment = false;
      line = line.slice(end + 3);
    }
    const open = FENCE.exec(line)?.[1];
    if (open) {
      fence = open;
      continue;
    }
    if (/^\s*:::/.test(line)) continue;
    const env = /^\s*\\begin\{([A-Za-z*]+)\}/.exec(line)?.[1];
    if (env) {
      if (!line.includes(`\\end{${env}}`)) latex = env;
      continue;
    }
    const include = INCLUDE.exec(line)?.[1];
    if (include) {
      includes.push({ line: i + 1, path: include });
      continue;
    }
    // Display math may span lines: keep only the text outside `$$ … $$`.
    let outside = '';
    const parts = line.split('$$');
    parts.forEach((part, n) => {
      if (n > 0) math = !math;
      if (!math) outside += ` ${part}`;
    });
    line = outside;
    const start = line.indexOf('<!--');
    if (start >= 0 && line.indexOf('-->', start) < 0) {
      comment = true;
      line = line.slice(0, start);
    }
    const heading = headingOf(lines[i] ?? '');
    if (heading) headings.push({ line: i + 1, ...heading });
    words[i] = countWords(prose(line));
  }

  // "Abstract" sections: their text is the abstract, not the body.
  const abstractRanges: [number, number][] = [];
  headings.forEach((h, n) => {
    if (!h.abstract) return;
    const next = headings.slice(n + 1).find((o) => o.level <= h.level);
    const end = next ? next.line - 1 : lines.length;
    abstractRanges.push([h.line, end]);
    for (let l = h.line + 1; l <= end; l++) abstract += words[l - 1] ?? 0;
  });
  const sectionWords = (from: number, to: number) => {
    let n = 0;
    for (let l = from; l <= to; l++) n += words[l - 1] ?? 0;
    return n;
  };
  const sections = headings.map((h, n) => {
    const next = headings.slice(n + 1).find((o) => o.level <= h.level);
    return { line: h.line, level: h.level, words: sectionWords(h.line, next ? next.line - 1 : lines.length) };
  });
  const inAbstract = (l: number) => abstractRanges.some(([a, b]) => l >= a && l <= b);
  const body = words.map((n, idx) => (inAbstract(idx + 1) ? 0 : n));
  return {
    lines: body,
    headings,
    includes,
    abstract,
    abstractRanges,
    total: body.reduce((a, b) => a + b, 0),
    sections: sections.map((s) => ({ line: s.line, level: s.level, words: s.words })),
  };
}

export interface PaperWords {
  /** Body words of the entry document and everything it includes. */
  total: number;
  abstract: number;
  /** Per file: its words with its includes, and its sections. */
  files: Record<string, { total: number; sections: SectionWords[] }>;
}

const MAX_DEPTH = 16;

/**
 * Word counts of the whole paper: the entry document with its includes
 * (each counted where it is included; cycles are cut), and of every other
 * text file on its own.
 */
export function paperWords(
  texts: ReadonlyMap<string, string>,
  entry: string | undefined,
  resolve: (from: string, raw: string) => string | undefined,
): PaperWords {
  const counted = new Map<string, FileWords>();
  const own = (path: string) => {
    let w = counted.get(path);
    if (!w) {
      w = countFileWords(texts.get(path) ?? '');
      counted.set(path, w);
    }
    return w;
  };
  const totals = new Map<string, number>();
  const abstracts = new Map<string, number>();
  const totalOf = (path: string, stack: string[]): number => {
    const memo = totals.get(path);
    if (memo !== undefined) return memo;
    const w = own(path);
    let total = w.total;
    let abstract = w.abstract;
    for (const inc of w.includes) {
      const target = resolve(path, inc.path);
      if (!target || stack.includes(target) || stack.length >= MAX_DEPTH || !texts.has(target)) continue;
      total += totalOf(target, [...stack, target]);
      abstract += abstracts.get(target) ?? 0;
    }
    totals.set(path, total);
    abstracts.set(path, abstract);
    return total;
  };
  const files: PaperWords['files'] = {};
  const text = [...texts.keys()].filter((p) => /\.(qmd|md|markdown)$/i.test(p));
  const total = entry && texts.has(entry) ? totalOf(entry, [entry]) : 0;
  const abstract = entry && texts.has(entry) ? (abstracts.get(entry) ?? 0) : 0;
  for (const path of text) {
    const w = own(path);
    const fileTotal = totalOf(path, [path]);
    const sections = w.headings.map((h, n) => {
      const next = w.headings.slice(n + 1).find((o) => o.level <= h.level);
      const end = next ? next.line - 1 : w.lines.length;
      let words = w.sections[n]?.words ?? 0;
      for (const inc of w.includes) {
        if (inc.line <= h.line || inc.line > end) continue;
        const target = resolve(path, inc.path);
        if (target && target !== path && texts.has(target)) words += totals.get(target) ?? totalOf(target, [path, target]);
      }
      return { line: h.line, level: h.level, words };
    });
    files[path] = { total: fileTotal, sections };
  }
  return { total, abstract, files };
}

export function wordStatus(counts: { total: number; abstract: number }, limits: WordLimits | undefined) {
  const totalOver = limits?.words !== undefined && counts.total > limits.words;
  const abstractOver = limits?.abstractWords !== undefined && counts.abstract > limits.abstractWords;
  return { over: totalOver || abstractOver, totalOver, abstractOver };
}
