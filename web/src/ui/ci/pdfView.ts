// The compiled PDF view (layout "PDF"): which state to show for a build of
// the default branch, the label of the build, and the per-session cache that
// keeps toggling the layout from downloading the artifact again. Pure rules;
// CompiledPdf.tsx renders them.

import type { BuildInfo, DocumentsResult } from '../../github/ci';
import type { Document } from '../../ci/unzip';
import { formatDateTime } from '../../i18n/format';

export type { BuildInfo };

export type CompiledPdf =
  /** No CI gateway (the demo, or a galley without GitHub Actions access). */
  | { kind: 'unavailable' }
  | { kind: 'loading' }
  | { kind: 'ready'; pdf: Blob; name: string; build?: BuildInfo; runUrl?: string }
  /** No build with a PDF, a build without one, an expired artifact, still compiling, or the fetch failed. */
  | { kind: 'none' | 'empty' | 'expired' | 'running' | 'failed'; runUrl?: string };

export function compiledPdfState(result: DocumentsResult): CompiledPdf {
  if (result.kind !== 'ready') return { kind: result.kind, runUrl: result.runUrl };
  const pdf = result.docs.pdf;
  if (!pdf) return { kind: 'empty', runUrl: result.runUrl };
  // Always application/pdf: the frame then shows the browser's PDF viewer,
  // never the bytes as another type, whatever the zip entry claimed.
  return {
    kind: 'ready',
    pdf: new Blob([pdf.bytes as BlobPart], { type: 'application/pdf' }),
    name: pdf.name,
    build: result.build,
    runUrl: result.runUrl,
  };
}

/** "PDF of main · 3f2a1c9 · 29 Oct 2026, 16:32"; without build details only the branch. */
export function buildLabel(build: BuildInfo | undefined, branch: string, lang: string, m: { label: (branch: string) => string }): string {
  const parts = [m.label(build?.branch || branch)];
  if (build?.sha) parts.push(build.sha.slice(0, 7));
  const when = build ? formatDateTime(build.createdAt, lang) : '';
  if (when) parts.push(when);
  return parts.join(' · ');
}

/** Fetch only with the PDF layout chosen, a CI gateway, and no compiled PDF cached yet. */
export function needsFetch(selected: boolean, hasCi: boolean, cached: CompiledPdf | undefined): boolean {
  return selected && hasCi && cached?.kind !== 'ready';
}

export interface PdfCache {
  get(repo: string, branch: string): CompiledPdf | undefined;
  /** Remembers a ready PDF and returns the state to show: the cached one for the same commit. */
  put(repo: string, branch: string, state: CompiledPdf): CompiledPdf;
}

/**
 * The latest compiled PDF per repository and branch, for this session (the
 * page's lifetime). Only ready PDFs are kept; a failed refresh leaves the last
 * good one cached. A refresh that finds the same commit keeps the first blob.
 */
export function createPdfCache(): PdfCache {
  const entries = new Map<string, Extract<CompiledPdf, { kind: 'ready' }>>();
  const key = (repo: string, branch: string) => `${repo}\n${branch}`;
  return {
    get: (repo, branch) => entries.get(key(repo, branch)),
    put(repo, branch, state) {
      if (state.kind !== 'ready') return state;
      const k = key(repo, branch);
      const previous = entries.get(k);
      if (previous && previous.build?.sha && previous.build.sha === state.build?.sha) return previous;
      entries.set(k, state);
      return state;
    },
  };
}

/** The session's cache, shared by every mount of the PDF view. */
export const sessionPdfCache = createPdfCache();

export type ToastOutcome =
  | { kind: 'ready'; pdf: Document; docx?: Document; diff?: Document; runUrl?: string }
  | { kind: Exclude<DocumentsResult['kind'], 'ready'>; runUrl?: string };

/** What the download toast offers for a build (usePdfDownload). */
export function toastOutcome(result: DocumentsResult): ToastOutcome {
  if (result.kind !== 'ready') return { kind: result.kind, runUrl: result.runUrl };
  const { pdf, docx, diff } = result.docs;
  if (!pdf) return { kind: 'empty', runUrl: result.runUrl };
  return { kind: 'ready', pdf, docx, diff, runUrl: result.runUrl };
}
