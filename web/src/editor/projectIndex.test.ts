import { describe, expect, it } from 'vitest';
import { buildIndex } from './projectIndex';
import { PROJECT } from './testProject';

describe('project index', () => {
  const index = buildIndex(PROJECT);

  it('turns bib entries into items with author, year, title and their line', () => {
    expect(index.bib).toEqual([
      { key: 'smith2020', author: 'Smith & Jones', year: '2020', title: 'Glow TL curves', path: 'references.bib', line: 2 },
      { key: 'doe1999', author: 'Doe et al.', year: '1999', title: 'Traps', path: 'references.bib', line: 9 },
    ]);
  });

  it('collects crossref labels from every .qmd in include order, with numbers and captions', () => {
    const byId = Object.fromEntries(index.labels.map((l) => [l.id, l]));
    expect(index.labels.map((l) => l.id)).toEqual([
      'sec-intro',
      'sec-aims',
      'sec-model',
      'fig-scheme',
      'eq-energy',
      'fig-plot',
      'tbl-params',
      'sec-spare',
    ]);
    expect(byId['sec-intro']).toMatchObject({ kind: 'sec', number: '1', caption: 'Introduction', path: 'sections/intro.qmd', line: 1 });
    expect(byId['sec-aims']).toMatchObject({ number: '1.1', caption: 'Aims', line: 5 });
    expect(byId['sec-model']).toMatchObject({ number: '2', caption: 'Model' });
    expect(byId['fig-scheme']).toMatchObject({ kind: 'fig', number: '1', caption: 'Energy-band scheme.', path: 'sections/model.qmd', line: 3 });
    expect(byId['eq-energy']).toMatchObject({ kind: 'eq', number: '1', line: 5 });
    expect(byId['fig-plot']).toMatchObject({ kind: 'fig', number: '2', caption: 'A generated plot.', line: 8 });
    expect(byId['tbl-params']).toMatchObject({ kind: 'tbl', number: '1', caption: 'Parameters of the model.', line: 17 });
  });

  it('keeps labels of files the entry does not include, without a number', () => {
    const spare = index.labels.find((l) => l.id === 'sec-spare');
    expect(spare).toMatchObject({ path: 'sections/unused.qmd', line: 1 });
    expect(spare?.number).toBeUndefined();
  });

  it('lists where each key is cited and counts the words of the paper', () => {
    const small = buildIndex({
      entry: 'index.qmd',
      paths: ['index.qmd', 'sections/a.qmd'],
      files: [
        { path: 'index.qmd', text: '---\nabstract: Two words.\n---\n\n{{< include sections/a.qmd >}}\n' },
        { path: 'sections/a.qmd', text: '# Intro\n\nAs @smith2020 said [@doe1999].\n' },
      ],
    });
    expect(small.cites).toEqual([
      { key: 'smith2020', path: 'sections/a.qmd', line: 3, text: 'As @smith2020 said [@doe1999].' },
      { key: 'doe1999', path: 'sections/a.qmd', line: 3, text: 'As @smith2020 said [@doe1999].' },
    ]);
    expect(small.words?.total).toBe(4);
    expect(small.words?.abstract).toBe(2);
    expect(small.words?.files['sections/a.qmd']?.sections).toEqual([{ line: 1, level: 1, words: 4 }]);
  });

  it('survives include cycles and missing files', () => {
    const cyclic = buildIndex({
      entry: 'a.qmd',
      paths: ['a.qmd', 'b.qmd'],
      files: [
        { path: 'a.qmd', text: '{{< include b.qmd >}}\n{{< include missing.qmd >}}\n# A {#sec-a}' },
        { path: 'b.qmd', text: '{{< include a.qmd >}}\n# B {#sec-b}' },
      ],
    });
    expect(cyclic.labels.map((l) => [l.id, l.number])).toEqual([
      ['sec-b', '1'],
      ['sec-a', '2'],
    ]);
  });
});
