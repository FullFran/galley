import { resolveInclude, type ProjectIndex } from './projectIndex';
import { CITE, IMAGE_SPAN, INCLUDE_SPAN, citeKey, isCrossref, resolveImage } from './refs';

export type DefinitionTarget =
  | { kind: 'file'; path: string }
  | { kind: 'image'; path: string }
  | { kind: 'label'; id: string; path: string; line: number }
  | { kind: 'citation'; key: string; path: string; line: number }
  /** Looks like a reference, but nothing in the repository matches it. */
  | { kind: 'missing'; name: string };

/** What the reference under `pos` points at: an included file, a figure, a label or a bib entry. */
export function definitionAt(text: string, pos: number, index: ProjectIndex, path: string): DefinitionTarget | undefined {
  const start = text.lastIndexOf('\n', pos - 1) + 1;
  const endAt = text.indexOf('\n', pos);
  const line = text.slice(start, endAt < 0 ? text.length : endAt);
  const col = pos - start;
  const known = new Set(index.paths);
  const within = (m: RegExpMatchArray, length = m[0].length) => m.index !== undefined && col >= m.index && col <= m.index + length;

  for (const m of line.matchAll(INCLUDE_SPAN)) {
    if (!within(m)) continue;
    const raw = m[1] ?? '';
    const target = resolveInclude(path, raw, known);
    return target ? { kind: 'file', path: target } : { kind: 'missing', name: raw };
  }
  for (const m of line.matchAll(IMAGE_SPAN)) {
    if (!within(m)) continue;
    const raw = m[1] ?? '';
    const target = resolveImage(raw, index.entry, known);
    return target ? { kind: 'image', path: target } : { kind: 'missing', name: raw };
  }
  for (const m of line.matchAll(CITE)) {
    const key = citeKey(m[1] ?? '');
    if (!key || !within(m, key.length + 1)) continue;
    if (isCrossref(key)) {
      const label = index.labels.find((l) => l.id === key);
      return label ? { kind: 'label', id: key, path: label.path, line: label.line } : { kind: 'missing', name: key };
    }
    const entry = index.bib.find((b) => b.key === key);
    return entry ? { kind: 'citation', key, path: entry.path, line: entry.line } : { kind: 'missing', name: key };
  }
  return undefined;
}
