import { describe, expect, it } from 'vitest';
import { citationsOf, findCitations } from './citations';
import { duplicateDoi, duplicateKey, duplicates, normalizeDoiKey } from './duplicates';
import { readLibrary, searchEntries, sortEntries } from './library';

const BIB = [
  '@article{benavente2024,',
  '  author = {Benavente, J. F. and Arquero, O. and Berenguer, J.},',
  '  title = {Effects of {TL} trapped charge},',
  '  year = {2024},',
  '  doi = {10.1016/J.OPTMAT.2024.116006}',
  '}',
  '',
  '@book{chen1997,',
  '  author = {Chen, R. and McKeever, S. W. S.},',
  '  title = {Theory of Thermoluminescence},',
  '  year = {1997}',
  '}',
  '',
  '@misc{Chen1997,',
  '  title = {Same key, other case},',
  '  doi = {https://doi.org/10.1016/j.optmat.2024.116006}',
  '}',
  '',
].join('\n');

describe('readLibrary', () => {
  it('lists entries with readable authors, year, title and type', () => {
    const lib = readLibrary([{ path: 'references.bib', text: BIB }]);
    expect(lib.map((e) => [e.key, e.authors, e.year, e.title, e.type])).toEqual([
      ['benavente2024', 'Benavente, Arquero & Berenguer', '2024', 'Effects of TL trapped charge', 'article'],
      ['chen1997', 'Chen & McKeever', '1997', 'Theory of Thermoluminescence', 'book'],
      ['Chen1997', '', '', 'Same key, other case', 'misc'],
    ]);
    expect(lib[0]?.family).toBe('Benavente');
  });

  it('searches key, authors, title and year, and sorts', () => {
    const lib = readLibrary([{ path: 'references.bib', text: BIB }]);
    expect(searchEntries(lib, 'mckeever').map((e) => e.key)).toEqual(['chen1997']);
    expect(searchEntries(lib, 'trapped 2024').map((e) => e.key)).toEqual(['benavente2024']);
    expect(searchEntries(lib, '').length).toBe(3);
    expect(sortEntries(lib, 'year').map((e) => e.key)).toEqual(['benavente2024', 'chen1997', 'Chen1997']);
    expect(sortEntries(lib, 'author').map((e) => e.key)).toEqual(['benavente2024', 'chen1997', 'Chen1997']);
    expect(sortEntries(lib, 'title').map((e) => e.key)).toEqual(['benavente2024', 'Chen1997', 'chen1997']);
  });
});

describe('duplicates', () => {
  const lib = readLibrary([{ path: 'references.bib', text: BIB }]);

  it('finds keys that differ only in case and DOIs written differently', () => {
    const found = duplicates(lib);
    expect(found.keys.get('chen1997')?.map((e) => e.key)).toEqual(['chen1997', 'Chen1997']);
    expect(found.dois.get('10.1016/j.optmat.2024.116006')?.map((e) => e.key)).toEqual(['benavente2024', 'Chen1997']);
  });

  it('checks a new key and a new DOI against the library', () => {
    expect(duplicateKey(lib, 'CHEN1997')?.key).toBe('chen1997');
    expect(duplicateKey(lib, 'chen1997', 'chen1997')?.key).toBe('Chen1997');
    expect(duplicateKey(lib, 'new2020')).toBeUndefined();
    expect(duplicateDoi(lib, 'doi:10.1016/j.optmat.2024.116006')?.key).toBe('benavente2024');
    expect(normalizeDoiKey(' https://dx.doi.org/10.1/ABC ')).toBe('10.1/abc');
  });
});

describe('citations', () => {
  const files = [
    { path: 'index.qmd', text: '---\ntitle: "@chen1997 in YAML"\n---\n\nAs shown [@chen1997; @benavente2024, p. 3].\n' },
    { path: 'sections/a.qmd', text: 'See @chen1997.\n\n```\n@chen1997 in code\n```\n\nMail me@chen1997.org and `@chen1997`.\nAlso @chen1997a and -@chen1997.\n' },
  ];

  it('lists the files and lines that cite a key, outside code and front matter', () => {
    expect(findCitations(files, 'chen1997')).toEqual([
      { path: 'index.qmd', line: 5, text: 'As shown [@chen1997; @benavente2024, p. 3].' },
      { path: 'sections/a.qmd', line: 1, text: 'See @chen1997.' },
      { path: 'sections/a.qmd', line: 8, text: 'Also @chen1997a and -@chen1997.' },
    ]);
  });

  it('indexes every cited key once per line', () => {
    const all = citationsOf(files);
    expect(all.filter((c) => c.key === 'chen1997').length).toBe(3);
    expect(all.filter((c) => c.key === 'chen1997a').length).toBe(1);
    expect(all.some((c) => c.key.startsWith('fig-'))).toBe(false);
  });
});
