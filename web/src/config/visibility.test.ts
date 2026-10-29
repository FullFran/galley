import { describe, expect, it } from 'vitest';
import { loadProjectConfig } from './load';
import { visibleFiles, type ProjectConfig } from './project';
import { parseConfig } from './schema';

const FILES = [
  '.galley.yml',
  '.github/workflows/ci.yml',
  '_quarto.yml',
  'index.qmd',
  'README.md',
  'STATE.md',
  'references.bib',
  'scripts/build.py',
  'sections/01-introduction.qmd',
  'sections/02-model.qmd',
  'sections/old/draft.qmd',
  'figures/fig1.png',
];

function valid(text: string): ProjectConfig {
  const { config, problems } = parseConfig(text);
  if (!config) throw new Error('expected a valid config');
  return { kind: 'valid', config, problems };
}

describe('visibleFiles', () => {
  const configured = valid('version: 1\neditable:\n  - index.qmd\n  - sections/*.qmd\n  - STATE.md\n');

  it('shows admins every file', () => {
    expect(visibleFiles(FILES, configured, true)).toEqual(FILES);
    expect(visibleFiles(FILES, { kind: 'missing' }, true)).toEqual(FILES);
  });

  it('shows co-authors only the editable files', () => {
    expect(visibleFiles(FILES, configured, false)).toEqual([
      'index.qmd',
      'STATE.md',
      'sections/01-introduction.qmd',
      'sections/02-model.qmd',
    ]);
  });

  it('shows co-authors the files already in an upload folder, of the accepted types', () => {
    const uploads = valid('version: 1\neditable:\n  - index.qmd\nuploads:\n  - folder: figures/\n    accept: [png, pdf]\n');
    const files = [...FILES, 'figures/fig2.pdf', 'figures/notes.txt', 'figures/raw/fig3.png'];
    expect(visibleFiles(files, uploads, false)).toEqual(['index.qmd', 'figures/fig1.png', 'figures/fig2.pdf', 'figures/raw/fig3.png']);
  });

  it('never shows .galley.yml to co-authors, even when listed', () => {
    const listed = valid('version: 1\neditable:\n  - .galley.yml\n  - "**"\n');
    const shown = visibleFiles(FILES, listed, false);
    expect(shown).not.toContain('.galley.yml');
    expect(shown).not.toContain('.github/workflows/ci.yml');
    expect(shown).toContain('scripts/build.py');
  });

  it('falls back to paper documents when the file is missing or invalid', () => {
    const fallback = ['index.qmd', 'README.md', 'STATE.md', 'references.bib', 'sections/01-introduction.qmd', 'sections/02-model.qmd', 'sections/old/draft.qmd'];
    expect(visibleFiles(FILES, { kind: 'missing' }, false)).toEqual(fallback);
    expect(visibleFiles(FILES, { kind: 'invalid', problems: [] }, false)).toEqual(fallback);
  });
});

describe('loadProjectConfig', () => {
  it('is missing when the repository has no .galley.yml', async () => {
    expect(await loadProjectConfig(['index.qmd'], () => Promise.reject(new Error('not read')))).toEqual({ kind: 'missing' });
  });

  it('parses the file at the given head', async () => {
    const state = await loadProjectConfig(['.galley.yml'], async (path) => {
      expect(path).toBe('.galley.yml');
      return 'version: 1\neditable: [index.qmd]\n';
    });
    expect(state.kind).toBe('valid');
  });

  it('reports invalid files with their problems', async () => {
    const state = await loadProjectConfig(['.galley.yml'], async () => 'version: 3\n');
    expect(state).toEqual({
      kind: 'invalid',
      problems: [
        { severity: 'error', message: 'Only "version: 1" is supported.' },
        { severity: 'error', message: '"editable" is missing: list the files co-authors can edit.' },
      ],
    });
  });

  it('treats an unreadable file as invalid', async () => {
    const state = await loadProjectConfig(['.galley.yml'], () => Promise.reject(new Error('binary')));
    expect(state).toEqual({ kind: 'invalid', problems: [{ severity: 'error', message: '.galley.yml could not be read as text.' }] });
  });
});
