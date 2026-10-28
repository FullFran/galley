import CSL from 'citeproc';
import style from './csl/elsevier-harvard.csl?raw';
import locale from './csl/locales-en-US.xml?raw';
import type { CslItem } from './bibtex';

/** One `@key` inside a citation, as written in the source. */
export interface CiteRef {
  key: string;
  prefix: string;
  suffix: string;
  suppressAuthor: boolean;
}

/** A citation: `[@a; @b]` (bracketed) or a bare in-text `@a`. */
export interface Cluster {
  refs: CiteRef[];
  inText: boolean;
}

export interface FormattedCitations {
  /** Citeproc HTML for each cluster, in input order. */
  clusters: string[];
  /** Bibliography entries for the cited keys, in style order. */
  entries: { key: string; html: string }[];
  missing: string[];
}

// Building an engine parses the style and locale (~100 ms), so keep one per
// bibliography content and reuse it across re-renders.
let cached: { signature: string; engine: InstanceType<typeof CSL.Engine> } | undefined;

function engineFor(items: Record<string, CslItem>, signature: string) {
  if (cached?.signature === signature) return cached.engine;
  const sys = { retrieveLocale: () => locale, retrieveItem: (id: string) => items[id] };
  const engine = new CSL.Engine(sys, style, 'en-US', true);
  cached = { signature, engine };
  return engine;
}

/** Formats citations with the vendored Elsevier Harvard CSL style. */
export function formatCitations(items: Record<string, CslItem>, signature: string, clusters: Cluster[]): FormattedCitations {
  const known = (key: string) => Object.hasOwn(items, key);
  const cited = [...new Set(clusters.flatMap((c) => c.refs.map((r) => r.key)))];
  const missing = cited.filter((k) => !known(k));
  const present = cited.filter(known);
  if (present.length === 0) {
    return { clusters: clusters.map(() => ''), entries: [], missing };
  }

  const engine = engineFor(items, signature);
  engine.updateItems(present);
  const one = (r: CiteRef, extra: { 'author-only'?: boolean; 'suppress-author'?: boolean } = {}) =>
    engine.makeCitationCluster([{ id: r.key, prefix: r.prefix || undefined, suffix: r.suffix || undefined, ...extra }]);

  const out = clusters.map((cluster) => {
    const refs = cluster.refs.filter((r) => known(r.key));
    if (refs.length === 0) return '';
    if (cluster.inText) {
      // Pandoc style in-text citation: "Author (Year)".
      return refs.map((r) => `${one(r, { 'author-only': true })} ${one(r, { 'suppress-author': true })}`).join('; ');
    }
    return engine.makeCitationCluster(
      refs.map((r) => ({
        id: r.key,
        prefix: r.prefix || undefined,
        suffix: r.suffix || undefined,
        'suppress-author': r.suppressAuthor || undefined,
      })),
    );
  });

  const bibliography = engine.makeBibliography();
  const entries = bibliography
    ? bibliography[1].map((html, i) => ({ key: bibliography[0].entry_ids[i]?.[0] ?? '', html: html.trim() }))
    : [];
  return { clusters: out, entries, missing };
}
