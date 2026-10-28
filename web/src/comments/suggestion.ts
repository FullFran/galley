import type { LineRange, Quote } from '../domain/comments';
import { lineOf, lineRangeOffsets } from './anchor';

// Applying a suggestion edits the user's buffer only (it is never committed
// here): the anchored range is found again in the current text, checked
// against the quote, and replaced. When the quoted text is gone, nothing is
// applied.

export interface Anchored extends LineRange {
  quote: Quote;
}

/** Where the anchored text is in `text` now, or undefined when it is gone. */
export function locateAnchor(text: string, anchor: Anchored): { from: number; to: number } | undefined {
  const { exact, prefix, suffix } = anchor.quote;
  if (!exact) return undefined;
  const stored = lineRangeOffsets(text, anchor);
  if (stored && text.slice(stored.from, stored.to) === exact) return stored;
  // The lines moved: score every occurrence by its context, then by distance.
  let best: { from: number; score: number; distance: number } | undefined;
  for (let i = text.indexOf(exact); i >= 0; i = text.indexOf(exact, i + 1)) {
    const before = text.slice(Math.max(0, i - prefix.length), i);
    const after = text.slice(i + exact.length, i + exact.length + suffix.length);
    const score = (prefix && before === prefix ? 2 : 0) + (suffix && after === suffix ? 2 : 0) + (before.endsWith(prefix.slice(-8)) ? 1 : 0);
    const distance = Math.abs(lineOf(text, i) - anchor.startLine);
    if (!best || score > best.score || (score === best.score && distance < best.distance)) best = { from: i, score, distance };
  }
  return best && { from: best.from, to: best.from + exact.length };
}

/** `text` with the anchored range replaced by `replacement`; undefined when it cannot be applied. */
export function applySuggestion(text: string, anchor: Anchored, replacement: string): string | undefined {
  const at = locateAnchor(text, anchor);
  if (!at) return undefined;
  return text.slice(0, at.from) + replacement + text.slice(at.to);
}
