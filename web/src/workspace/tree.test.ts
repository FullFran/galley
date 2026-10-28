import { describe, expect, it } from 'vitest';
import { buildTree, fileKind } from './tree';

describe('buildTree', () => {
  it('nests files under folders, folders first, both sorted', () => {
    const tree = buildTree(['z.md', 'chapters/b.qmd', 'chapters/a.qmd', 'a.bib']);
    expect(tree).toEqual([
      {
        kind: 'folder',
        name: 'chapters',
        path: 'chapters',
        children: [
          { kind: 'file', name: 'a.qmd', path: 'chapters/a.qmd' },
          { kind: 'file', name: 'b.qmd', path: 'chapters/b.qmd' },
        ],
      },
      { kind: 'file', name: 'a.bib', path: 'a.bib' },
      { kind: 'file', name: 'z.md', path: 'z.md' },
    ]);
  });
});

describe('fileKind', () => {
  it('classifies documents, other text and binary files', () => {
    expect(fileKind('paper/index.qmd')).toBe('document');
    expect(fileKind('refs.BIB')).toBe('document');
    expect(fileKind('_quarto.yml')).toBe('document');
    expect(fileKind('script.R')).toBe('text');
    expect(fileKind('figures/plot.png')).toBe('binary');
  });
});
