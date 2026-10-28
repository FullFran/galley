// BibTeX as text with byte ranges, for editing a .bib file without
// reformatting it. Entries that are not edited keep every byte: an edit
// replaces only the changed values (or the key, the type, a removed field's
// line) inside the entry's range, a new entry is appended after a blank line,
// and new text follows the file's own line endings, indentation, alignment,
// delimiters and letter case. Nothing here evaluates the file; it is scanned
// as plain text.

export type FieldKind = 'braced' | 'quoted' | 'raw';

export interface BibField {
  /** As written (case kept). */
  name: string;
  /** Inside the delimiters for braced and quoted values; the whole expression for raw ones (macros, numbers, `#`). */
  value: string;
  kind: FieldKind;
  nameStart: number;
  /** Where the value expression starts and ends (delimiters included). */
  valueStart: number;
  valueEnd: number;
}

export interface BibEntry {
  /** As written, e.g. `article` or `BOOK`. */
  type: string;
  key: string;
  /** `@` of the entry. */
  start: number;
  /** Just after the closing `}` or `)`. */
  end: number;
  typeStart: number;
  keyStart: number;
  /** Just after the comma that follows the key (or the key itself when there is none). */
  bodyStart: number;
  fields: BibField[];
}

export interface BibScan {
  entries: BibEntry[];
  errors: string[];
}

export interface DraftField {
  name: string;
  value: string;
  /** Unset: the delimiter of the entry, else of the file. */
  kind?: FieldKind;
}

export interface EntryDraft {
  type: string;
  key: string;
  fields: DraftField[];
}

export interface BibStyle {
  eol: '\n' | '\r\n';
  indent: string;
  /** `=` signs line up within an entry. */
  align: boolean;
  /** Spaces before `=` (the smallest gap when aligned) and the text after it. */
  gap: number;
  afterEq: string;
  delim: 'braced' | 'quoted';
  nameCase: 'lower' | 'upper';
  typeCase: 'lower' | 'upper' | 'capital';
  trailingComma: boolean;
}

class ScanError extends Error {}

const SPECIAL = /^(comment|preamble|string)$/i;

function lineStart(text: string, p: number): number {
  return text.lastIndexOf('\n', p - 1) + 1;
}

function skipSpace(text: string, p: number): number {
  while (p < text.length && /\s/.test(text[p] ?? '')) p++;
  return p;
}

/** The index just after the balanced group that opens at `p`. */
function skipGroup(text: string, p: number): number {
  const open = text[p];
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let i = p; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === open || (open === '(' && c === '{')) depth++;
    else if (c === close || (open === '(' && c === '}')) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new ScanError('unbalanced braces');
}

function readValue(text: string, p: number): { kind: FieldKind; value: string; start: number; end: number } {
  p = skipSpace(text, p);
  const start = p;
  let parts = 0;
  let kind: FieldKind;
  let inner = '';
  for (;;) {
    p = skipSpace(text, p);
    const c = text[p];
    if (c === '{') {
      const end = skipGroup(text, p);
      kind = 'braced';
      inner = text.slice(p + 1, end - 1);
      p = end;
    } else if (c === '"') {
      let depth = 0;
      let i = p + 1;
      for (; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\') i++;
        else if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === '"' && depth === 0) break;
      }
      if (text[i] !== '"') throw new ScanError('unterminated quoted value');
      kind = 'quoted';
      inner = text.slice(p + 1, i);
      p = i + 1;
    } else {
      const word = /^[\w:.+-]+/.exec(text.slice(p, p + 256))?.[0];
      if (!word) throw new ScanError('expected a value');
      kind = 'raw';
      p += word.length;
    }
    parts++;
    const after = skipSpace(text, p);
    if (text[after] !== '#') break;
    p = after + 1;
  }
  const end = p;
  if (parts > 1 || kind === 'raw') return { kind: 'raw', value: text.slice(start, end), start, end };
  return { kind, value: inner, start, end };
}

/** Finds the entries of a .bib file with their byte ranges. Malformed entries are skipped and reported. */
export function scanBib(text: string): BibScan {
  const entries: BibEntry[] = [];
  const errors: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const at = text.indexOf('@', pos);
    if (at < 0) break;
    // `%` lines are comments (biber); an `@` there starts nothing.
    if (/^[ \t]*%/.test(text.slice(lineStart(text, at), at + 1))) {
      const eol = text.indexOf('\n', at);
      pos = eol < 0 ? text.length : eol + 1;
      continue;
    }
    const head = /^@[ \t]*([A-Za-z]+)\s*([{(])/.exec(text.slice(at, at + 64));
    if (!head) {
      pos = at + 1;
      continue;
    }
    const type = head[1] ?? '';
    const close = head[2] === '(' ? ')' : '}';
    const open = at + head[0].length - 1;
    try {
      if (SPECIAL.test(type)) {
        pos = skipGroup(text, open);
        continue;
      }
      let p = open + 1;
      const keyMatch = /^\s*([^\s,{}()"=#%]+)\s*(,?)/.exec(text.slice(p, p + 512));
      if (!keyMatch?.[1]) throw new ScanError('missing citation key');
      const keyStart = p + keyMatch[0].indexOf(keyMatch[1]);
      const key = keyMatch[1];
      p += keyMatch[0].length;
      const bodyStart = keyMatch[2] ? p : keyStart + key.length;
      const fields: BibField[] = [];
      for (;;) {
        p = skipSpace(text, p);
        if (p >= text.length) throw new ScanError('missing the end of the entry');
        if (text[p] === close) break;
        if (text[p] === ',') {
          p++;
          continue;
        }
        const m = /^([A-Za-z][\w:.+-]*)\s*=/.exec(text.slice(p, p + 128));
        if (!m?.[1]) throw new ScanError('expected a field');
        const nameStart = p;
        const value = readValue(text, p + m[0].length);
        fields.push({ name: m[1], value: value.value, kind: value.kind, nameStart, valueStart: value.start, valueEnd: value.end });
        p = value.end;
      }
      entries.push({ type, key, start: at, end: p + 1, typeStart: at + head[0].indexOf(type), keyStart, bodyStart, fields });
      pos = p + 1;
    } catch (err) {
      errors.push(`entry at offset ${at}: ${err instanceof Error ? err.message : String(err)}`);
      const next = text.slice(at + 1).search(/\n\s*@/);
      pos = next < 0 ? text.length : at + 1 + next + 1;
    }
  }
  return { entries, errors };
}

/** The draft of an existing entry, with its values as written. */
export function draftOf(entry: BibEntry): EntryDraft {
  return { type: entry.type, key: entry.key, fields: entry.fields.map((f) => ({ name: f.name, value: f.value, kind: f.kind })) };
}

/** A value that can stay unquoted: a number, a macro or a `#` concatenation. */
export function rawExpressionOk(value: string): boolean {
  if (!value.trim() || /[\r\n]/.test(value)) return false;
  const probe = `@misc{k, f = ${value}}`;
  const field = scanBib(probe).entries[0]?.fields[0];
  return field?.kind === 'raw' && field.value === value && field.valueEnd === probe.length - 1;
}

/** Why a value cannot be written as is: braces must balance (a `\{` does not count). */
export function valueProblem(value: string): 'unbalanced' | undefined {
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\') i++;
    else if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return 'unbalanced';
  }
  return depth === 0 ? undefined : 'unbalanced';
}

interface FieldLayout {
  /** Spaces between the name and `=`. */
  gap: number;
  afterEq: string;
  /** Leading whitespace when the field starts its own line. */
  indent?: string;
  /** Column of `=` relative to the name. */
  column: number;
}

function layoutOf(text: string, field: BibField): FieldLayout {
  const between = text.slice(field.nameStart + field.name.length, field.valueStart);
  const eq = between.indexOf('=');
  const before = text.slice(lineStart(text, field.nameStart), field.nameStart);
  return {
    gap: eq,
    afterEq: between.slice(eq + 1),
    indent: /^[ \t]*$/.test(before) ? before : undefined,
    column: field.name.length + eq,
  };
}

function aligned(text: string, entry: BibEntry): boolean | undefined {
  const own = entry.fields.map((f) => layoutOf(text, f)).filter((l) => l.indent !== undefined);
  if (own.length < 2 || new Set(entry.fields.map((f) => f.name.length)).size < 2) return undefined;
  return own.every((l) => l.column === own[0]?.column);
}

function majority<T>(values: T[], fallback: T): T {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = fallback;
  let max = 0;
  for (const [v, n] of counts) if (n > max) [best, max] = [v, n];
  return best;
}

function caseOf(word: string): 'lower' | 'upper' | 'capital' {
  if (word === word.toLowerCase()) return 'lower';
  if (word === word.toUpperCase()) return 'upper';
  return 'capital';
}

/** The file's way of writing BibTeX, from its existing entries. */
export function detectStyle(text: string, entries: BibEntry[] = scanBib(text).entries): BibStyle {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const layouts = entries.flatMap((e) => e.fields.map((f) => layoutOf(text, f)));
  const own = layouts.filter((l) => l.indent !== undefined);
  const alignedVotes = entries.map((e) => aligned(text, e)).filter((v): v is boolean => v !== undefined);
  const fields = entries.flatMap((e) => e.fields);
  const delimited = fields.filter((f) => f.kind !== 'raw').map((f) => f.kind as 'braced' | 'quoted');
  const named = fields.filter((f) => /[A-Za-z]/.test(f.name)).map((f) => (f.name === f.name.toUpperCase() && f.name !== f.name.toLowerCase() ? 'upper' : 'lower'));
  const trailing = entries
    .filter((e) => e.fields.length > 0)
    .map((e) => {
      const last = e.fields[e.fields.length - 1] as BibField;
      return text[skipSpace(text, last.valueEnd)] === ',';
    });
  const alignedGaps = own.length ? Math.min(...own.map((l) => l.gap)) : 1;
  return {
    eol: crlf > 0 && crlf >= lf ? '\r\n' : '\n',
    indent: majority(
      own.map((l) => l.indent as string),
      '  ',
    ),
    align: majority(alignedVotes, true),
    gap: majority(alignedVotes, true) ? Math.max(alignedGaps, 0) : majority(own.map((l) => l.gap), 1),
    afterEq: majority(
      layouts.map((l) => l.afterEq),
      ' ',
    ),
    delim: majority(delimited, 'braced'),
    nameCase: majority(named, 'lower'),
    typeCase: majority(
      entries.map((e) => caseOf(e.type)),
      'lower',
    ),
    trailingComma: majority(trailing, false),
  };
}

function applyCase(word: string, mode: 'lower' | 'upper' | 'capital'): string {
  if (mode === 'upper') return word.toUpperCase();
  if (mode === 'capital') return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  return word.toLowerCase();
}

/** A value with its delimiters; braces are used when quotes cannot hold it. */
function formatValue(field: DraftField, kind: FieldKind, eol: string): string {
  const value = field.value.replace(/\r?\n/g, eol);
  if (kind === 'raw') return value;
  if (kind === 'quoted') {
    let depth = 0;
    let quoteAtTop = false;
    for (let i = 0; i < value.length; i++) {
      const c = value[i];
      if (c === '\\') i++;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '"' && depth === 0) quoteAtTop = true;
    }
    if (!quoteAtTop) return `"${value}"`;
  }
  return `{${value}}`;
}

function fieldName(name: string, mode: 'lower' | 'upper'): string {
  return mode === 'upper' ? name.toUpperCase() : name.toLowerCase();
}

/** A whole new entry in the given style, without a final line break. */
export function formatEntry(draft: EntryDraft, style: BibStyle): string {
  const names = draft.fields.map((f) => fieldName(f.name, style.nameCase));
  const width = Math.max(0, ...names.map((n) => n.length));
  const lines = draft.fields.map((f, i) => {
    const name = names[i] ?? f.name;
    const pad = style.align ? ' '.repeat(width - name.length + style.gap) : ' '.repeat(style.gap);
    const comma = i < draft.fields.length - 1 || style.trailingComma ? ',' : '';
    return `${style.indent}${name}${pad}=${style.afterEq}${formatValue(f, f.kind ?? style.delim, style.eol)}${comma}`;
  });
  const head = `@${applyCase(draft.type, style.typeCase)}{${draft.key},`;
  return [head, ...lines, '}'].join(style.eol);
}

/** Appends a new entry after a blank line, ending with a line break. */
export function appendEntry(text: string, draft: EntryDraft, style: BibStyle = detectStyle(text)): string {
  const entry = formatEntry(draft, style);
  if (text.trim() === '') return `${entry}${style.eol}`;
  let out = text;
  if (!out.endsWith('\n')) out += style.eol;
  if (!out.endsWith(`${style.eol}${style.eol}`) && !/\n[ \t]*\r?\n$/.test(out)) out += style.eol;
  return `${out}${entry}${style.eol}`;
}

interface Splice {
  from: number;
  to: number;
  insert: string;
}

function applySplices(text: string, splices: Splice[]): string {
  let out = text;
  for (const s of [...splices].sort((a, b) => b.from - a.from || b.to - a.to)) out = out.slice(0, s.from) + s.insert + out.slice(s.to);
  return out;
}

/**
 * The file with `entry` changed to `draft`. Only changed values, the type,
 * the key, removed fields and new fields are touched; everything else in the
 * file, including the rest of this entry, stays as it was.
 */
export function updateEntry(text: string, entry: BibEntry, draft: EntryDraft, style: BibStyle = detectStyle(text)): string {
  const splices: Splice[] = [];
  const eol = style.eol;
  if (draft.type !== entry.type) {
    const type = draft.type.toLowerCase() === entry.type.toLowerCase() ? draft.type : applyCase(draft.type, caseOf(entry.type));
    splices.push({ from: entry.typeStart, to: entry.typeStart + entry.type.length, insert: type });
  }
  if (draft.key !== entry.key) splices.push({ from: entry.keyStart, to: entry.keyStart + entry.key.length, insert: draft.key });

  // The entry's own habits win over the file's.
  const own = entry.fields.filter((f) => f.kind !== 'raw').map((f) => f.kind as 'braced' | 'quoted');
  const delim = own.length ? majority(own, style.delim) : style.delim;
  const named = entry.fields.map((f) => (f.name === f.name.toUpperCase() && f.name !== f.name.toLowerCase() ? 'upper' : 'lower'));
  const nameCase = named.length ? majority(named, style.nameCase) : style.nameCase;

  const pending = [...draft.fields];
  const kept: BibField[] = [];
  for (const field of entry.fields) {
    const i = pending.findIndex((d) => d.name.toLowerCase() === field.name.toLowerCase());
    if (i < 0) {
      splices.push(removeField(text, field));
      continue;
    }
    const next = pending.splice(i, 1)[0] as DraftField;
    kept.push(field);
    const kind = next.kind ?? field.kind;
    if (next.value !== field.value || kind !== field.kind) {
      splices.push({ from: field.valueStart, to: field.valueEnd, insert: formatValue(next, kind, eol) });
    }
  }

  if (pending.length) {
    const anchor = kept[kept.length - 1];
    const layouts = entry.fields.map((f) => layoutOf(text, f));
    const first = layouts[0];
    const isAligned = aligned(text, entry) ?? style.align;
    const column = first?.column;
    const indent = (anchor ? layoutOf(text, anchor).indent : undefined) ?? first?.indent ?? style.indent;
    const gap = first?.gap ?? style.gap;
    const afterEq = first?.afterEq ?? style.afterEq;
    const line = (f: DraftField) => {
      const name = fieldName(f.name, nameCase);
      const pad = isAligned && column !== undefined ? Math.max(column - name.length, Math.min(gap, 1)) : gap;
      return `${indent}${name}${' '.repeat(pad)}=${afterEq}${formatValue(f, f.kind ?? delim, eol)}`;
    };
    const lines = pending.map(line);
    if (anchor) {
      const after = skipSpace(text, anchor.valueEnd);
      if (text[after] === ',') splices.push({ from: after + 1, to: after + 1, insert: lines.map((l) => `${eol}${l},`).join('') });
      else splices.push({ from: anchor.valueEnd, to: anchor.valueEnd, insert: `,${lines.map((l) => `${eol}${l}`).join(',')}` });
    } else {
      const comma = text.slice(entry.keyStart + entry.key.length, entry.bodyStart).includes(',') ? '' : ',';
      const trailing = style.trailingComma ? ',' : '';
      splices.push({ from: entry.bodyStart, to: entry.bodyStart, insert: `${comma}${lines.map((l) => `${eol}${l}`).join(',')}${trailing}` });
    }
  }
  return splices.length ? applySplices(text, splices) : text;
}

/** A field with its comma; its whole line when it stands alone on it. */
function removeField(text: string, field: BibField): Splice {
  let end = field.valueEnd;
  while (text[end] === ' ' || text[end] === '\t') end++;
  if (text[end] === ',') end++;
  while (text[end] === ' ' || text[end] === '\t') end++;
  const start = lineStart(text, field.nameStart);
  const alone = /^[ \t]*$/.test(text.slice(start, field.nameStart));
  if (alone && (text[end] === '\n' || text.startsWith('\r\n', end))) {
    return { from: start, to: end + (text[end] === '\r' ? 2 : 1), insert: '' };
  }
  return { from: field.nameStart, to: end, insert: '' };
}

/** The file without `entry` and without one of the blank lines around it. */
export function removeEntry(text: string, entry: BibEntry): string {
  let start = entry.start;
  const ls = lineStart(text, start);
  if (/^[ \t]*$/.test(text.slice(ls, start))) start = ls;
  let end = entry.end;
  while (text[end] === ' ' || text[end] === '\t') end++;
  if (text.startsWith('\r\n', end)) end += 2;
  else if (text[end] === '\n') end += 1;
  let before = text.slice(0, start);
  let after = text.slice(end);
  const blank = /^[ \t]*\r?\n/.exec(after);
  if (blank && (before === '' || before.endsWith('\n'))) after = after.slice(blank[0].length);
  else if (after === '') before = before.replace(/(\r?\n)[ \t]*\r?\n$/, '$1');
  return before + after;
}
