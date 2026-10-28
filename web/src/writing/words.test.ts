import { describe, expect, it } from 'vitest';
import { countFileWords, countWords, paperWords, wordStatus } from './words';

describe('countWords', () => {
  it('counts words, numbers and hyphenated or abbreviated words as one', () => {
    expect(countWords('The glow-curve peaks at 4,512 K, e.g. here.')).toBe(8);
    expect(countWords('  ')).toBe(0);
    expect(countWords('Dosimetría con LiF')).toBe(3);
  });
});

describe('countFileWords', () => {
  const text = [
    '---',
    'title: "A long title that is not counted"',
    'abstract: |',
    '  We fit a model with $n = 3$ traps',
    '  to a synthetic curve [@chen1997].',
    'keywords: [a, b]',
    '---',
    '',
    '# Introduction {#sec-intro}',
    '',
    'Thermoluminescence is old [@randall1945; @chen1997, p. 3]. See @fig-scheme.',
    '',
    '![A scheme with many caption words](figures/scheme.png){#fig-scheme width=50%}',
    '',
    '```{python}',
    '#| label: fig-x',
    'print("no words here")',
    '```',
    '',
    '$$',
    'E = mc^2 \\text{ words }',
    '$$ {#eq-e}',
    '',
    '## Model',
    '',
    'The rate is $k = s e^{-E/kT}$ and `code words` are skipped.<!-- a comment -->',
    '<!--',
    'hidden words',
    '-->',
    '::: {.callout-note}',
    'A [linked text](https://example.org) note.[^1]',
    ':::',
    '',
    '# Conclusions',
    '',
    'Done.',
  ].join('\n');

  it('skips front matter, code, math, citation brackets, figures, comments and markup', () => {
    const words = countFileWords(text);
    // Introduction (1) + "Thermoluminescence is old. See @fig-scheme." (5)
    // + Model (1) + "The rate is and are skipped." (6) + "A linked text note." (4)
    // + Conclusions (1) + Done (1)
    expect(words.total).toBe(19);
    expect(words.abstract).toBe(10);
  });

  it('gives per-section counts that include subsections', () => {
    const words = countFileWords(text);
    expect(words.sections).toEqual([
      { line: 9, level: 1, words: 17 },
      { line: 24, level: 2, words: 11 },
      { line: 34, level: 1, words: 2 },
    ]);
  });

  it('counts an "Abstract" section as the abstract, not the body', () => {
    const words = countFileWords('# Abstract\n\nShort summary here.\n\n# Intro\n\nBody text.\n');
    expect(words.abstract).toBe(3);
    expect(words.total).toBe(3);
    expect(words.sections.map((s) => s.words)).toEqual([4, 3]);
  });
});

describe('paperWords', () => {
  const files = new Map([
    ['index.qmd', '---\nabstract: Five words in this abstract.\n---\n\n{{< include sections/_a.qmd >}}\n\n{{< include sections/_b.qmd >}}\n'],
    ['sections/_a.qmd', '# Intro\n\nOne two three.\n\n{{< include _nested.qmd >}}\n'],
    ['sections/_nested.qmd', 'Four five.\n'],
    ['sections/_b.qmd', '# Methods\n\nSix.\n\n{{< include ../index.qmd >}}\n'],
    ['other.qmd', 'Not included at all.\n'],
  ]);
  const resolve = (from: string, raw: string) => {
    const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
    const joined = (dir + raw).split('/').reduce<string[]>((acc, seg) => (seg === '..' ? acc.slice(0, -1) : [...acc, seg]), []).join('/');
    return files.has(joined) ? joined : undefined;
  };

  it('adds included files, once, and ignores include cycles', () => {
    const words = paperWords(files, 'index.qmd', resolve);
    expect(words.total).toBe(8);
    expect(words.abstract).toBe(5);
    expect(words.files['sections/_a.qmd']?.total).toBe(6);
    expect(words.files['sections/_a.qmd']?.sections).toEqual([{ line: 1, level: 1, words: 6 }]);
    expect(words.files['other.qmd']?.total).toBe(4);
  });

  it('is empty without an entry document', () => {
    expect(paperWords(files, undefined, resolve).total).toBe(0);
  });
});

describe('wordStatus', () => {
  it('flags the total and the abstract against the limits', () => {
    expect(wordStatus({ total: 7999, abstract: 251 }, { words: 8000, abstractWords: 250 })).toEqual({ over: true, totalOver: false, abstractOver: true });
    expect(wordStatus({ total: 8001, abstract: 0 }, { words: 8000 })).toEqual({ over: true, totalOver: true, abstractOver: false });
    expect(wordStatus({ total: 9000, abstract: 900 }, undefined)).toEqual({ over: false, totalOver: false, abstractOver: false });
  });
});
