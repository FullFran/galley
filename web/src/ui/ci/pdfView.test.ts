import { describe, expect, it } from 'vitest';
import type { DocumentsResult } from '../../github/ci';
import { en } from '../../i18n/en';
import { es } from '../../i18n/es';
import { formatDateTime } from '../../i18n/format';
import { buildLabel, compiledPdfState, createPdfCache, needsFetch, toastOutcome, type CompiledPdf } from './pdfView';

const bytes = new TextEncoder().encode('%PDF-1.7 x');
const pdf = { name: 'paper.pdf', type: 'application/octet-stream', bytes };
const docx = { name: 'paper.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: new Uint8Array([80, 75]) };
const build = { sha: '3f2a1c9d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49', branch: 'main', createdAt: '2026-10-29T16:32:00Z' };
const run = 'https://github.com/octo/paper/actions/runs/100';
const ready: DocumentsResult = { kind: 'ready', docs: { pdf, docx }, runUrl: run, build };

describe('compiled PDF state from the CI gateway', () => {
  it('ready: the PDF as an application/pdf blob, with its build and run', async () => {
    const state = compiledPdfState(ready);
    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    // Always rendered as a PDF, whatever type the zip entry claimed.
    expect(state.pdf.type).toBe('application/pdf');
    expect(new Uint8Array(await state.pdf.arrayBuffer())).toEqual(bytes);
    expect(state.name).toBe('paper.pdf');
    expect(state.build).toEqual(build);
    expect(state.runUrl).toBe(run);
  });

  it('a build without a PDF reads as empty', () => {
    expect(compiledPdfState({ kind: 'ready', docs: { docx }, runUrl: run })).toEqual({ kind: 'empty', runUrl: run });
  });

  it('keeps the other outcomes and their run links: none, empty, expired, running', () => {
    for (const kind of ['none', 'empty', 'expired', 'running'] as const) {
      expect(compiledPdfState({ kind, runUrl: run })).toEqual({ kind, runUrl: run });
    }
    expect(compiledPdfState({ kind: 'none' })).toEqual({ kind: 'none', runUrl: undefined });
  });
});

describe('label of the build shown', () => {
  it('names the branch, the short commit and the build time, in the active language', () => {
    const when = formatDateTime(build.createdAt, 'en');
    expect(buildLabel(build, 'main', 'en', en.ci.pdfView)).toBe(`PDF of main · 3f2a1c9 · ${when}`);
    const cuando = formatDateTime(build.createdAt, 'es');
    expect(buildLabel(build, 'main', 'es', es.ci.pdfView)).toBe(`PDF de main · 3f2a1c9 · ${cuando}`);
  });

  it('falls back to the branch alone without build details', () => {
    expect(buildLabel(undefined, 'main', 'en', en.ci.pdfView)).toBe('PDF of main');
    expect(buildLabel({ ...build, createdAt: 'not a date' }, 'main', 'en', en.ci.pdfView)).toBe('PDF of main · 3f2a1c9');
  });
});

describe('fetching only when the PDF layout is chosen, once per session', () => {
  const readyState = compiledPdfState(ready);

  it('fetches only with the PDF layout chosen and a CI gateway', () => {
    expect(needsFetch(false, true, undefined)).toBe(false);
    expect(needsFetch(true, false, undefined)).toBe(false);
    expect(needsFetch(true, true, undefined)).toBe(true);
  });

  it('does not fetch again while a compiled PDF is cached; tries again after a non-ready outcome', () => {
    expect(needsFetch(true, true, readyState)).toBe(false);
    expect(needsFetch(true, true, { kind: 'none' })).toBe(true);
  });

  it('caches ready PDFs per repository and branch; the same commit keeps the cached blob', () => {
    const cache = createPdfCache();
    expect(cache.get('octo/paper', 'main')).toBeUndefined();
    const first = cache.put('octo/paper', 'main', readyState);
    expect(cache.get('octo/paper', 'main')).toBe(first);
    expect(cache.get('octo/other', 'main')).toBeUndefined();
    // A refresh that finds the same commit keeps the first blob (no new object URL).
    const again = cache.put('octo/paper', 'main', compiledPdfState(ready));
    expect(again).toBe(first);
    // A newer commit replaces it.
    const newer = compiledPdfState({ ...ready, build: { ...build, sha: 'abcdef1234567' } } as DocumentsResult);
    expect(cache.put('octo/paper', 'main', newer)).toBe(newer);
    expect(cache.get('octo/paper', 'main')).toBe(newer);
  });

  it('does not cache outcomes without a PDF, and keeps the last good PDF when a refresh fails', () => {
    const cache = createPdfCache();
    const none: CompiledPdf = { kind: 'none' };
    expect(cache.put('octo/paper', 'main', none)).toBe(none);
    expect(cache.get('octo/paper', 'main')).toBeUndefined();
    const good = cache.put('octo/paper', 'main', readyState);
    cache.put('octo/paper', 'main', { kind: 'failed' });
    expect(cache.get('octo/paper', 'main')).toBe(good);
  });
});

describe('the existing download toast', () => {
  it('still offers the PDF, the DOCX and the run of a ready build', () => {
    expect(toastOutcome(ready)).toEqual({ kind: 'ready', pdf, docx, diff: undefined, runUrl: run });
  });

  it('still reports empty, expired, running and none with the run link', () => {
    expect(toastOutcome({ kind: 'ready', docs: { docx }, runUrl: run })).toEqual({ kind: 'empty', runUrl: run });
    expect(toastOutcome({ kind: 'expired', runUrl: run })).toEqual({ kind: 'expired', runUrl: run });
    expect(toastOutcome({ kind: 'none' })).toEqual({ kind: 'none', runUrl: undefined });
  });
});
