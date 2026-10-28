import type { ProjectIndex } from './projectIndex';
import { CITE, citeKey, isCrossref, maskCode } from './refs';

export interface RefProblem {
  from: number;
  to: number;
  kind: 'unknown-citation' | 'dangling-crossref';
  key: string;
}

/** Citations whose key is in no .bib file, and crossrefs to labels defined nowhere. */
export function findRefProblems(text: string, index: ProjectIndex): RefProblem[] {
  const keys = new Set(index.bib.map((b) => b.key));
  const labels = new Set(index.labels.map((l) => l.id));
  const problems: RefProblem[] = [];
  for (const m of maskCode(text).matchAll(CITE)) {
    const key = citeKey(m[1] ?? '');
    if (!key) continue;
    const from = m.index;
    const to = from + 1 + key.length;
    if (isCrossref(key)) {
      if (!labels.has(key)) problems.push({ from, to, kind: 'dangling-crossref', key });
    } else if (!keys.has(key)) problems.push({ from, to, kind: 'unknown-citation', key });
  }
  return problems;
}
