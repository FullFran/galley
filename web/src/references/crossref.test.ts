import { describe, expect, it } from 'vitest';
import { CrossrefError, crossrefUrl, fetchDoi, normalizeDoi } from './crossref';

// What api.crossref.org returns for /transform/application/x-bibtex: one line,
// a leading space, upper-case DOI/ISSN, a bare month and a dx.doi.org URL.
const CROSSREF =
  ' @article{Benavente_2024, title={Effects of trapped charge transitions}, volume={156}, ISSN={0925-3467}, url={http://dx.doi.org/10.1016/j.optmat.2024.116006}, DOI={10.1016/j.optmat.2024.116006}, journal={Optical Materials}, publisher={Elsevier BV}, author={Benavente, J.F. and Arquero, O.}, year={2024}, month=oct, pages={116006} }\n';

function fakeFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url);
  };
  return { fn: fn as typeof fetch, calls };
}

describe('normalizeDoi', () => {
  it('accepts bare DOIs, doi: prefixes and doi.org links', () => {
    expect(normalizeDoi('10.1016/j.optmat.2024.116006')).toBe('10.1016/j.optmat.2024.116006');
    expect(normalizeDoi(' doi:10.1016/J.OPTMAT.2024.116006 ')).toBe('10.1016/J.OPTMAT.2024.116006');
    expect(normalizeDoi('https://doi.org/10.1103/PhysRev.47.777')).toBe('10.1103/PhysRev.47.777');
    expect(normalizeDoi('http://dx.doi.org/10.1000/a%2Fb')).toBe('10.1000/a/b');
  });

  it('refuses anything else', () => {
    expect(normalizeDoi('')).toBeUndefined();
    expect(normalizeDoi('10.1/x')).toBeUndefined();
    expect(normalizeDoi('https://example.org/10.1016/x')).toBeUndefined();
    expect(normalizeDoi('10.1016/has space')).toBeUndefined();
  });
});

describe('crossrefUrl', () => {
  it('builds the transform URL with an optional mailto', () => {
    expect(crossrefUrl('10.1016/j.optmat.2024.116006')).toBe('https://api.crossref.org/works/10.1016/j.optmat.2024.116006/transform/application/x-bibtex');
    expect(crossrefUrl('10.1000/a?b#c', 'ana@example.org')).toBe('https://api.crossref.org/works/10.1000/a%3Fb%23c/transform/application/x-bibtex?mailto=ana%40example.org');
  });
});

describe('fetchDoi', () => {
  it('fetches and parses the BibTeX into a draft in a conventional field order', async () => {
    const f = fakeFetch(() => new Response(CROSSREF, { status: 200 }));
    const draft = await fetchDoi('10.1016/j.optmat.2024.116006', { fetch: f.fn });
    expect(f.calls[0]?.url).toBe(crossrefUrl('10.1016/j.optmat.2024.116006'));
    expect(f.calls[0]?.init?.credentials).toBe('omit');
    expect(draft.type).toBe('article');
    expect(draft.fields.map((x) => x.name)).toEqual(['author', 'title', 'journal', 'year', 'month', 'volume', 'pages', 'publisher', 'doi', 'issn']);
    expect(draft.fields.find((x) => x.name === 'month')).toEqual({ name: 'month', value: 'oct', kind: 'raw' });
    expect(draft.fields.find((x) => x.name === 'doi')?.value).toBe('10.1016/j.optmat.2024.116006');
  });

  it('keeps a URL that is not just the DOI link', async () => {
    const body = CROSSREF.replace('http://dx.doi.org/10.1016/j.optmat.2024.116006', 'https://example.org/paper');
    const draft = await fetchDoi('10.1016/j.optmat.2024.116006', { fetch: fakeFetch(() => new Response(body)).fn });
    expect(draft.fields.find((x) => x.name === 'url')?.value).toBe('https://example.org/paper');
  });

  it('reports a DOI Crossref does not know, a network failure and junk', async () => {
    await expect(fetchDoi('10.1016/x', { fetch: fakeFetch(() => new Response('Resource not found.', { status: 404 })).fn })).rejects.toMatchObject({ reason: 'not-found' });
    await expect(
      fetchDoi('10.1016/x', {
        fetch: (async () => {
          throw new TypeError('Failed to fetch');
        }) as typeof fetch,
      }),
    ).rejects.toMatchObject({ reason: 'network' });
    await expect(fetchDoi('10.1016/x', { fetch: fakeFetch(() => new Response('<html>oops</html>')).fn })).rejects.toBeInstanceOf(CrossrefError);
    await expect(fetchDoi('10.1016/x', { fetch: fakeFetch(() => new Response('x'.repeat(300_000))).fn })).rejects.toMatchObject({ reason: 'invalid' });
    await expect(fetchDoi('nope', { fetch: fakeFetch(() => new Response(CROSSREF)).fn })).rejects.toMatchObject({ reason: 'invalid-doi' });
  });
});
