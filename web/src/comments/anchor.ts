import type { LineRange, Quote } from '../domain/comments';

// Builds the anchor of a new thread from a selection in a file's text: a
// 1-based line range (with columns when the selection is not whole lines)
// and a W3C TextQuoteSelector (exact text plus about 32 characters of context
// on each side), which lets the server carry the thread forward as the text
// changes. Offsets and columns count UTF-16 code units, like the editor.

export const QUOTE_CONTEXT = 32;
/** The server's limit for `quote.exact`, in UTF-8 bytes. */
export const MAX_QUOTE_BYTES = 20 * 1024;
/** Characters the server refuses in any text field. */
// NUL is the one control character the server refuses (tabs and newlines are fine).
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000\u202A-\u202E\u2066-\u2069]/;

export type AnchorResult =
  | { kind: 'ok'; range: LineRange; quote: Quote; from: number; to: number }
  | { kind: 'empty' }
  | { kind: 'too-long' }
  | { kind: 'unsupported' };

/** Offsets where each line starts. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** 0-based index of the line holding `offset`. */
function lineIndex(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const lineEnd = (text: string, starts: number[], index: number) => {
  const next = starts[index + 1];
  return next === undefined ? text.length : next - 1;
};

const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

function prefixOf(text: string, from: number): string {
  let start = Math.max(0, from - QUOTE_CONTEXT);
  if (start > 0 && isLow(text.charCodeAt(start))) start++;
  const raw = text.slice(start, from);
  let cut = -1;
  for (let i = 0; i < raw.length; i++) if (FORBIDDEN.test(raw.charAt(i))) cut = i;
  return cut < 0 ? raw : raw.slice(cut + 1);
}

function suffixOf(text: string, to: number): string {
  let end = Math.min(text.length, to + QUOTE_CONTEXT);
  if (end < text.length && isLow(text.charCodeAt(end))) end--;
  const raw = text.slice(to, end);
  const cut = raw.search(FORBIDDEN);
  return cut < 0 ? raw : raw.slice(0, cut);
}

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/**
 * The anchor for the selection `from`..`to` of `text`. An empty selection
 * means its whole line. A selection that ends at the start of a line ends on
 * the line before.
 */
export function buildAnchor(text: string, from: number, to: number): AnchorResult {
  const starts = lineStarts(text);
  let a = Math.max(0, Math.min(from, to, text.length));
  let b = Math.min(text.length, Math.max(from, to, 0));
  let whole = false;
  if (a === b) {
    const i = lineIndex(starts, a);
    a = starts[i] ?? 0;
    b = lineEnd(text, starts, i);
    whole = true;
  }
  let startIndex = lineIndex(starts, a);
  let endIndex = lineIndex(starts, b);
  if (!whole && endIndex > startIndex && b === starts[endIndex]) {
    endIndex--;
    b = lineEnd(text, starts, endIndex);
  }
  // A selection starting on the very end of a line starts on the next one.
  if (!whole && startIndex < endIndex && a === lineEnd(text, starts, startIndex)) {
    startIndex++;
    a = starts[startIndex] ?? a;
  }
  const exact = text.slice(a, b);
  if (exact.trim() === '') return { kind: 'empty' };
  if (FORBIDDEN.test(exact)) return { kind: 'unsupported' };
  if (exact.length > MAX_QUOTE_BYTES || utf8Length(exact) > MAX_QUOTE_BYTES) return { kind: 'too-long' };
  const range: LineRange = { startLine: startIndex + 1, endLine: endIndex + 1 };
  if (!whole) {
    range.startColumn = a - (starts[startIndex] ?? 0) + 1;
    range.endColumn = b - (starts[endIndex] ?? 0);
  }
  return { kind: 'ok', range, quote: { exact, prefix: prefixOf(text, a), suffix: suffixOf(text, b) }, from: a, to: b };
}

/** Offsets of a stored range in `text`; undefined when the lines are not there. */
export function lineRangeOffsets(text: string, range: LineRange): { from: number; to: number } | undefined {
  const starts = lineStarts(text);
  const startStart = starts[range.startLine - 1];
  const endStart = starts[range.endLine - 1];
  if (startStart === undefined || endStart === undefined || range.endLine < range.startLine) return undefined;
  const endOfLast = lineEnd(text, starts, range.endLine - 1);
  if (range.startColumn === undefined || range.endColumn === undefined) return { from: startStart, to: endOfLast };
  const from = startStart + range.startColumn - 1;
  const to = endStart + range.endColumn;
  if (from > lineEnd(text, starts, range.startLine - 1) || to > endOfLast || to < from) return undefined;
  return { from, to };
}

/** 1-based line of an offset. */
export function lineOf(text: string, offset: number): number {
  return lineIndex(lineStarts(text), offset) + 1;
}

