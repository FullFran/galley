import { describe, expect, it } from 'vitest';
import { parseBibtex } from './bibtex';

describe('parseBibtex', () => {
  it('converts entries to CSL-JSON with names, accents and page ranges', () => {
    const { items, errors } = parseBibtex(`
% comment line
@string{optm = "Opt. Mater."}
@article{benavente2019,
  author  = {Benavente, J. F. and G{\\'o}mez-Ros, J. M. and Romero, A. M.},
  year    = {2019},
  title   = {Glow curve deconvolution for {FOM} analysis},
  journal = optm,
  volume  = 153,
  pages   = {108843--108850},
  doi     = {10.1016/j.apradiso.2019.108843}
}
@book{chen1997, author = "Chen, R. and Stephen W. S. McKeever", year = 1997,
  title = "Theory of {T}hermoluminescence", publisher = {World Scientific}, address = {Singapore}}
@comment{ignored}
`);
    expect(errors).toEqual([]);
    expect(items.benavente2019).toEqual({
      id: 'benavente2019',
      type: 'article-journal',
      author: [
        { family: 'Benavente', given: 'J. F.' },
        { family: 'Gómez-Ros', given: 'J. M.' },
        { family: 'Romero', given: 'A. M.' },
      ],
      issued: { 'date-parts': [[2019]] },
      title: 'Glow curve deconvolution for <span class="nocase">FOM</span> analysis',
      'container-title': 'Opt. Mater.',
      volume: '153',
      page: '108843-108850',
      DOI: '10.1016/j.apradiso.2019.108843',
    });
    expect(items.chen1997?.author).toEqual([
      { family: 'Chen', given: 'R.' },
      { family: 'McKeever', given: 'Stephen W. S.' },
    ]);
    expect(items.chen1997?.publisher).toBe('World Scientific');
    expect(items.chen1997?.['publisher-place']).toBe('Singapore');
  });

  it('handles particles, organisations and escaped characters', () => {
    const { items } = parseBibtex(
      '@misc{k, author = {van der Berg, Jan and {Euro Agency for Things} and Ludwig van Beethoven}, title = {A \\& B: 50\\% of {\\"u}ber -- part}, year = {2001}}',
    );
    expect(items.k?.author).toEqual([
      { family: 'Berg', given: 'Jan', 'non-dropping-particle': 'van der' },
      { literal: 'Euro Agency for Things' },
      { family: 'Beethoven', given: 'Ludwig', 'non-dropping-particle': 'van' },
    ]);
    expect(items.k?.title).toBe('A & B: 50% of über – part');
  });

  // citeproc escapes markup outside its formatting tags; render.test.ts checks the output.
  it('keeps markup in field values as text', () => {
    const { items } = parseBibtex('@article{x, title = {<script>alert(1)</script>}, year = 2000}');
    expect(items.x?.title).toBe('<script>alert(1)</script>');
  });

  it('reports malformed entries and keeps the good ones', () => {
    const { items, errors } = parseBibtex('@article{bad, title = {unclosed\n@book{good, title = {Fine}, year = 1999}');
    expect(Object.keys(items)).toContain('good');
    expect(errors.length).toBeGreaterThan(0);
  });
});
