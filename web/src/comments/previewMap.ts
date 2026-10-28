import { lineStarts } from './anchor';

// Maps text selected in the preview back to the source. The preview tags each
// block with the source line it starts on (`data-src="path:line"`) and the
// line it ends on, so the selection is first narrowed to those lines; the
// rendered text is then looked up in them, tolerating the Markdown markup and
// line breaks that the rendering removed. When it cannot be found (maths,
// citations, numbering) the thread anchors to the whole block instead.

export interface PreviewSelection {
  /** 1-based first and last source line of the blocks the selection touches. */
  startLine: number;
  endLine: number;
  /** The selected text, as rendered. */
  text: string;
}

export interface MappedSelection {
  from: number;
  to: number;
  /** False when the text was not found and the range is the whole block. */
  exact: boolean;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** What rendering removes between words: spaces, line breaks and emphasis or code marks. */
const GAP = '[\\s*_`~]+';
const MAX_WORDS = 200;

export function mapPreviewSelection(source: string, sel: PreviewSelection): MappedSelection | undefined {
  const starts = lineStarts(source);
  const first = Math.max(1, Math.min(sel.startLine, sel.endLine));
  const last = Math.max(sel.startLine, sel.endLine);
  const from = starts[first - 1];
  if (from === undefined) return undefined;
  const lastIndex = Math.min(last, starts.length) - 1;
  const next = starts[lastIndex + 1];
  const to = next === undefined ? source.length : next - 1;
  const block = source.slice(from, to);
  const wanted = sel.text.trim();

  if (wanted) {
    const direct = block.indexOf(wanted);
    if (direct >= 0) return { from: from + direct, to: from + direct + wanted.length, exact: true };
    const words = wanted.split(/\s+/).filter(Boolean);
    if (words.length > 0 && words.length <= MAX_WORDS) {
      // Linear: each word is a literal, separated by one bounded character class.
      const match = new RegExp(words.map(escape).join(GAP)).exec(block);
      if (match) return { from: from + match.index, to: from + match.index + match[0].length, exact: true };
    }
  }
  // Trim surrounding blank lines of the fallback block.
  const lead = block.length - block.trimStart().length;
  const trail = block.length - block.trimEnd().length;
  if (lead + trail >= block.length) return undefined;
  return { from: from + lead, to: to - trail, exact: false };
}
