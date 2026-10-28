import { scanBib, type DraftField, type EntryDraft } from './bibFile';

// DOI to BibTeX through Crossref's content negotiation endpoint
// (api.crossref.org, CORS `*`). The request carries no cookies or
// credentials; `mailto` (the signed-in person's address, when galley knows
// it) puts it in Crossref's "polite" pool. The reply is untrusted text: it is
// size-capped, scanned like any .bib file and only ever shown as text.

export const CROSSREF_ORIGIN = 'https://api.crossref.org';
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;

export type CrossrefReason = 'invalid-doi' | 'not-found' | 'network' | 'invalid';

export class CrossrefError extends Error {
  constructor(readonly reason: CrossrefReason) {
    super(`crossref: ${reason}`);
    this.name = 'CrossrefError';
  }
}

const DOI = /^10\.\d{4,9}\/\S+$/;

/** A DOI from a bare DOI, `doi:…` or a doi.org link; undefined for anything else. */
export function normalizeDoi(input: string): string | undefined {
  let s = input.trim();
  s = s.replace(/^doi:\s*/i, '');
  const link = /^https?:\/\/(?:dx\.)?doi\.org\/(.+)$/i.exec(s);
  if (link) {
    try {
      s = decodeURIComponent(link[1] ?? '');
    } catch {
      return undefined;
    }
  } else if (/^[a-z]+:/i.test(s)) return undefined;
  return DOI.test(s) ? s : undefined;
}

export function crossrefUrl(doi: string, mailto?: string): string {
  const path = doi
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  const query = mailto ? `?mailto=${encodeURIComponent(mailto)}` : '';
  return `${CROSSREF_ORIGIN}/works/${path}/transform/application/x-bibtex${query}`;
}

const ORDER = ['author', 'editor', 'title', 'journal', 'booktitle', 'year', 'month', 'volume', 'number', 'pages', 'publisher', 'doi'];

/** Crossref's fields, lower-cased, in a familiar order, without a URL that only repeats the DOI. */
function tidy(fields: DraftField[], doi: string): DraftField[] {
  const lower = fields.map((f) => ({ ...f, name: f.name.toLowerCase() }));
  const redundant = (f: DraftField) => f.name === 'url' && /^https?:\/\/(dx\.)?doi\.org\//i.test(f.value) && f.value.toLowerCase().endsWith(doi.toLowerCase());
  const rank = (name: string) => {
    const i = ORDER.indexOf(name);
    return i < 0 ? ORDER.length : i;
  };
  return lower
    .filter((f) => !redundant(f))
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f.name) - rank(b.f.name) || a.i - b.i)
    .map(({ f }) => f);
}

export interface FetchDoiOptions {
  fetch?: typeof fetch;
  mailto?: string;
  signal?: AbortSignal;
}

/** Looks a DOI up on Crossref and returns its entry as a draft (the key is Crossref's; callers replace it). */
export async function fetchDoi(input: string, options: FetchDoiOptions = {}): Promise<EntryDraft> {
  const doi = normalizeDoi(input);
  if (!doi) throw new CrossrefError('invalid-doi');
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  const abort = () => timeout.abort();
  options.signal?.addEventListener('abort', abort);
  let text: string;
  try {
    const response = await doFetch(crossrefUrl(doi, options.mailto), {
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/x-bibtex' },
      signal: timeout.signal,
    });
    if (response.status === 404) throw new CrossrefError('not-found');
    if (!response.ok) throw new CrossrefError('network');
    text = await response.text();
  } catch (err) {
    if (err instanceof CrossrefError) throw err;
    throw new CrossrefError('network');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
  if (text.length > MAX_BYTES) throw new CrossrefError('invalid');
  const entry = scanBib(text).entries[0];
  if (!entry || entry.fields.length === 0) throw new CrossrefError('invalid');
  return {
    type: entry.type.toLowerCase(),
    key: entry.key,
    fields: tidy(
      entry.fields.map((f) => ({ name: f.name, value: f.value, kind: f.kind })),
      doi,
    ),
  };
}
