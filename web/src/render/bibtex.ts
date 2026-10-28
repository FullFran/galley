// A small BibTeX reader that produces CSL-JSON for citeproc-js. It covers the
// usual entry types and fields, @string macros, braces, quotes, `#`
// concatenation and the common LaTeX accent commands. Field values are
// returned as citeproc "micro HTML": protected braces become
// <span class="nocase">. Other markup is left as text; citeproc escapes
// everything outside its small set of formatting tags.

export interface CslName {
  family?: string;
  given?: string;
  'non-dropping-particle'?: string;
  literal?: string;
}

export interface CslItem {
  id: string;
  type: string;
  [field: string]: unknown;
}

export interface BibtexResult {
  items: Record<string, CslItem>;
  errors: string[];
}

const TYPES: Record<string, string> = {
  article: 'article-journal',
  book: 'book',
  booklet: 'pamphlet',
  inbook: 'chapter',
  incollection: 'chapter',
  inproceedings: 'paper-conference',
  conference: 'paper-conference',
  manual: 'report',
  mastersthesis: 'thesis',
  phdthesis: 'thesis',
  thesis: 'thesis',
  techreport: 'report',
  report: 'report',
  unpublished: 'manuscript',
  online: 'webpage',
  misc: 'document',
  dataset: 'dataset',
  software: 'software',
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const ACCENTS: Record<string, string> = {
  "'": '́',
  '`': '̀',
  '^': '̂',
  '"': '̈',
  '~': '̃',
  '=': '̄',
  '.': '̇',
  u: '̆',
  v: '̌',
  H: '̋',
  c: '̧',
  k: '̨',
  r: '̊',
  d: '̣',
  b: '̱',
};

const SYMBOLS: Record<string, string> = {
  ss: 'ß',
  o: 'ø',
  O: 'Ø',
  ae: 'æ',
  AE: 'Æ',
  oe: 'œ',
  OE: 'Œ',
  aa: 'å',
  AA: 'Å',
  l: 'ł',
  L: 'Ł',
  i: 'ı',
  j: 'ȷ',
  textendash: '–',
  textemdash: '—',
  textquoteright: '’',
  textquoteleft: '‘',
  textdegree: '°',
};

class ParseError extends Error {}

/** Parses BibTeX text. Malformed entries are skipped and reported in `errors`. */
export function parseBibtex(src: string): BibtexResult {
  const items: Record<string, CslItem> = {};
  const errors: string[] = [];
  const strings: Record<string, string> = Object.fromEntries(MONTHS.map((m, i) => [m, String(i + 1)]));
  let pos = 0;

  while (pos < src.length) {
    const at = src.indexOf('@', pos);
    if (at < 0) break;
    const head = /^@\s*([A-Za-z]+)\s*([{(])/.exec(src.slice(at, at + 64));
    if (!head) {
      pos = at + 1;
      continue;
    }
    const kind = (head[1] ?? '').toLowerCase();
    const close = head[2] === '(' ? ')' : '}';
    let p = at + head[0].length;
    try {
      if (kind === 'comment' || kind === 'preamble') {
        pos = skipBalanced(src, p - 1);
        continue;
      }
      if (kind === 'string') {
        const [name, value, end] = readField(src, p, strings);
        strings[name.toLowerCase()] = value;
        p = skipSpace(src, end);
        if (src[p] !== close) throw new ParseError('expected the end of @string');
        pos = p + 1;
        continue;
      }
      const keyMatch = /^\s*([^\s,{}()"=#%]+)\s*,/.exec(src.slice(p, p + 256));
      if (!keyMatch?.[1]) throw new ParseError('missing citation key');
      const key = keyMatch[1];
      p += keyMatch[0].length;
      const fields: Record<string, string> = {};
      for (;;) {
        p = skipSpace(src, p);
        if (src[p] === close) break;
        if (src[p] === ',') {
          p++;
          continue;
        }
        const [name, value, end] = readField(src, p, strings);
        fields[name.toLowerCase()] = value;
        p = end;
      }
      pos = p + 1;
      items[key] = toCsl(key, kind, fields);
    } catch (err) {
      errors.push(`entry at offset ${at}: ${err instanceof Error ? err.message : String(err)}`);
      // Resume at the next line that starts an entry.
      const next = src.slice(at + 1).search(/\n\s*@/);
      pos = next < 0 ? src.length : at + 1 + next + 1;
    }
  }
  return { items, errors };
}

function skipSpace(src: string, p: number): number {
  while (p < src.length && /\s/.test(src[p] ?? '')) p++;
  return p;
}

/** Returns the index just after the group that opens at `p`. */
function skipBalanced(src: string, p: number): number {
  const open = src[p];
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let i = p; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') i++;
    else if (c === open || (open === '(' && c === '{')) depth++;
    else if (c === close || (open === '(' && c === '}')) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new ParseError('unbalanced braces');
}

/** Reads `name = value` starting at `p`; returns the raw (still LaTeX) value. */
function readField(src: string, p: number, strings: Record<string, string>): [string, string, number] {
  const m = /^\s*([A-Za-z][\w:.+-]*)\s*=\s*/.exec(src.slice(p, p + 128));
  if (!m?.[1]) throw new ParseError('expected a field');
  p += m[0].length;
  let value = '';
  for (;;) {
    p = skipSpace(src, p);
    const c = src[p];
    if (c === '{') {
      const end = skipBalanced(src, p);
      value += src.slice(p + 1, end - 1);
      p = end;
    } else if (c === '"') {
      let depth = 0;
      let i = p + 1;
      for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === '\\') i++;
        else if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === '"' && depth === 0) break;
        if (ch === '@' && src[i - 1] === '\n') break;
      }
      if (src[i] !== '"') throw new ParseError('unterminated quoted value');
      value += src.slice(p + 1, i);
      p = i + 1;
    } else {
      const word = /^[\w:.+-]+/.exec(src.slice(p, p + 128))?.[0];
      if (!word) throw new ParseError(`bad value for ${m[1]}`);
      value += /^\d+$/.test(word) ? word : (strings[word.toLowerCase()] ?? word);
      p += word.length;
    }
    p = skipSpace(src, p);
    if (src[p] !== '#') break;
    p++;
  }
  return [m[1], value, p];
}

/** LaTeX to plain Unicode text; braces are dropped. */
function latexToText(s: string): string {
  let out = s
    .replace(/\\([`'^"~=.])\s*\{?\s*(\\?[A-Za-z])\s*\}?/g, (_m, acc: string, ch: string) =>
      (ch.replace('\\', '') === 'i' ? 'i' : ch.replace('\\', '')) + (ACCENTS[acc] ?? ''),
    )
    .replace(/\\([uvHckrdb])\s*\{\s*(\\?[A-Za-z])\s*\}/g, (_m, acc: string, ch: string) => ch.replace('\\', '') + (ACCENTS[acc] ?? ''))
    .replace(/\\([A-Za-z]+)\b\s*(\{\})?/g, (m, name: string) => SYMBOLS[name] ?? (name === 'url' || name === 'emph' || name === 'textit' || name === 'textbf' ? '' : m))
    .replace(/\\([&%$#_{}])/g, '$1')
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/~/g, '\u00a0');
  out = out.replace(/[{}]/g, '');
  return out.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Like latexToText, but returns micro HTML where top-level braced groups are
 * protected from case changes, as BibTeX does.
 */
function latexToRich(s: string): string {
  let out = '';
  let depth = 0;
  let chunk = '';
  const flush = (protect: boolean) => {
    if (!chunk) return;
    const text = latexToText(chunk);
    const lead = /^\s/.test(chunk) && out ? ' ' : '';
    const trail = /\s$/.test(chunk) ? ' ' : '';
    out += lead + (protect && text ? `<span class="nocase">${text}</span>` : text) + trail;
    chunk = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? '';
    if (c === '\\') {
      // Keep commands and their braced argument together, e.g. {\'o} or \'{o}.
      const m = /^\\(?:[A-Za-z]+|.)\s*(\{[^{}]*\})?/.exec(s.slice(i));
      const text = m?.[0] ?? c;
      chunk += text;
      i += text.length - 1;
    } else if (c === '{') {
      if (depth === 0) flush(false);
      if (depth > 0) chunk += c;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        // A group that only holds a command, like {\'o}, is an accent, not a protected word.
        const protect = !/^\\[^A-Za-z]/.test(chunk.trim());
        flush(protect);
      } else chunk += c;
    } else chunk += c;
  }
  flush(depth > 0);
  return out.replace(/\s+/g, ' ').trim();
}

const PARTICLE = /^(?:van|von|der|den|de|del|della|di|da|du|la|le|dos|das|ten|ter|zu|y)$/;

function splitTopLevel(s: string, sep: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0) {
      const m = sep.exec(s.slice(i));
      if (m && m.index === 0) {
        parts.push(s.slice(start, i));
        i += m[0].length - 1;
        start = i + 1;
      }
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function parseName(raw: string): CslName {
  const trimmed = raw.trim();
  if (/^\{[^{}]*\}$/.test(trimmed)) return { literal: latexToText(trimmed) };
  const commas = splitTopLevel(trimmed, /^,/);
  let words: string[];
  let given: string;
  if (commas.length >= 2) {
    words = splitTopLevel(commas[0] ?? '', /^\s+/);
    given = commas[commas.length - 1] ?? '';
  } else {
    const all = splitTopLevel(trimmed, /^\s+/);
    const firstParticle = all.findIndex((w, i) => i < all.length - 1 && PARTICLE.test(w));
    const split = firstParticle >= 0 ? firstParticle : all.length - 1;
    given = all.slice(0, split).join(' ');
    words = all.slice(split);
  }
  const particles: string[] = [];
  while (words.length > 1 && PARTICLE.test(words[0] ?? '')) particles.push(words.shift() ?? '');
  const name: CslName = { family: latexToText(words.join(' ')) };
  if (given) name.given = latexToText(given);
  if (particles.length) name['non-dropping-particle'] = particles.join(' ');
  return name;
}

function toCsl(id: string, kind: string, f: Record<string, string>): CslItem {
  const item: CslItem = { id, type: TYPES[kind] ?? 'document' };
  const rich = (name: string, value: string | undefined) => {
    if (value !== undefined && value.trim()) item[name] = latexToRich(value);
  };
  const plain = (name: string, value: string | undefined) => {
    if (value !== undefined && value.trim()) item[name] = latexToText(value);
  };
  if (f.author) item.author = splitTopLevel(f.author, /^\s+and\s+/).map(parseName);
  if (f.editor) item.editor = splitTopLevel(f.editor, /^\s+and\s+/).map(parseName);
  const year = /\d{4}/.exec(f.date ?? f.year ?? '')?.[0];
  if (year) {
    const parts = [Number(year)];
    const month = Number(f.month);
    if (month >= 1 && month <= 12) parts.push(month);
    item.issued = { 'date-parts': [parts] };
  }
  rich('title', f.title);
  rich('container-title', f.journal ?? f.journaltitle ?? f.booktitle);
  plain('volume', f.volume);
  plain('issue', kind === 'techreport' || kind === 'report' ? undefined : f.number);
  plain('number', kind === 'techreport' || kind === 'report' ? f.number : undefined);
  if (f.pages) item.page = latexToText(f.pages).replace(/\s*[–—-]+\s*/g, '-');
  rich('publisher', f.publisher ?? f.school ?? f.institution ?? f.organization);
  plain('publisher-place', f.address ?? f.location);
  plain('edition', f.edition);
  plain('genre', kind === 'phdthesis' ? 'PhD thesis' : kind === 'mastersthesis' ? 'Master’s thesis' : undefined);
  rich('note', f.note);
  plain('ISBN', f.isbn);
  plain('ISSN', f.issn);
  if (f.doi) item.DOI = f.doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
  if (f.url) item.URL = f.url.trim();
  return item;
}
