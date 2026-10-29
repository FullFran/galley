import { describe, expect, it } from 'vitest';
import { buildTree, fileAction, fileKind } from './tree';

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

describe('fileAction', () => {
  const uploads = ['figures/'];

  it('opens text and document files in the editor, as before', () => {
    expect(fileAction('index.qmd', { uploadFolders: uploads })).toEqual({ kind: 'open' });
    expect(fileAction('notes.txt', { uploadFolders: uploads })).toEqual({ kind: 'open' });
    expect(fileAction('logo.svg', { uploadFolders: [] })).toEqual({ kind: 'open' });
  });

  it('shows images in an upload folder in the figure viewer, svg included', () => {
    for (const p of ['figures/fig1_band_scheme.png', 'figures/a.JPG', 'figures/b.jpeg', 'figures/c.gif', 'figures/d.webp', 'figures/e.svg']) {
      expect(fileAction(p, { uploadFolders: uploads })).toEqual({ kind: 'view', as: 'image' });
    }
  });

  it('opens a pdf in an upload folder outside the editor', () => {
    expect(fileAction('figures/fig2_closure.pdf', { uploadFolders: uploads })).toEqual({ kind: 'view', as: 'pdf' });
  });

  it('keeps other binaries, and images outside upload folders, disabled', () => {
    expect(fileAction('figures/data.zip', { uploadFolders: uploads })).toEqual({ kind: 'none' });
    expect(fileAction('other/plot.png', { uploadFolders: uploads })).toEqual({ kind: 'none' });
    expect(fileAction('other/paper.pdf', { uploadFolders: uploads, anyImage: true })).toEqual({ kind: 'none' });
  });

  it('lets admins view any image file', () => {
    expect(fileAction('other/plot.png', { uploadFolders: uploads, anyImage: true })).toEqual({ kind: 'view', as: 'image' });
    expect(fileAction('logo.svg', { uploadFolders: [], anyImage: true })).toEqual({ kind: 'view', as: 'image' });
  });

  it('matches upload folders written with or without the trailing slash, not by prefix', () => {
    expect(fileAction('figures/x.png', { uploadFolders: ['figures'] })).toEqual({ kind: 'view', as: 'image' });
    expect(fileAction('figures-old/x.png', { uploadFolders: ['figures/'] })).toEqual({ kind: 'none' });
  });
});
