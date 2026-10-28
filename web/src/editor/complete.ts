import { dirname } from '../render/source';
import { isText, type LabelKind, type ProjectIndex } from './projectIndex';
import { CITE_BEFORE_CURSOR, isImage } from './refs';

export interface CompletionItem {
  label: string;
  type: 'citation' | 'crossref' | 'file' | 'image';
  /** Short text next to the label ("Smith & Jones 2020"). */
  detail?: string;
  /** Longer text (a title or a caption). */
  info?: string;
  kind?: LabelKind;
  number?: string;
}

export interface CompletionResult {
  /** Where the typed prefix starts; the chosen label replaces `from`…cursor. */
  from: number;
  items: CompletionItem[];
}

const relative = (dir: string, path: string) => (dir && path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path);

/** Completions for the cursor at `pos` in `text` (the file at `path`); null when none apply. */
export function completeAt(text: string, pos: number, index: ProjectIndex, path: string): CompletionResult | null {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const before = text.slice(lineStart, pos);

  const include = /\{\{<\s*include\s+["']?([^\s"'>]*)$/.exec(before);
  if (include) {
    const dir = dirname(path);
    const items = index.paths
      .filter((p) => isText(p) && p !== path)
      .map((p) => relative(dir, p))
      .sort()
      .map((label): CompletionItem => ({ label, type: 'file' }));
    return { from: pos - (include[1]?.length ?? 0), items };
  }

  const image = /!\[[^\]]*\]\(([^)\s]*)$/.exec(before);
  if (image) {
    const dir = dirname(index.entry ?? '');
    const items = index.paths
      .filter(isImage)
      .map((p) => relative(dir, p))
      .sort()
      .map((label): CompletionItem => ({ label, type: 'image' }));
    return { from: pos - (image[1]?.length ?? 0), items };
  }

  const cite = CITE_BEFORE_CURSOR.exec(before);
  if (cite) {
    const labels = index.labels.map(
      (l): CompletionItem => ({ label: l.id, type: 'crossref', kind: l.kind, number: l.number, info: l.caption }),
    );
    const bib = index.bib.map(
      (b): CompletionItem => ({
        label: b.key,
        type: 'citation',
        detail: [b.author, b.year].filter(Boolean).join(' ') || undefined,
        info: b.title,
      }),
    );
    return { from: pos - (cite[1]?.length ?? 0), items: [...labels, ...bib] };
  }
  return null;
}
