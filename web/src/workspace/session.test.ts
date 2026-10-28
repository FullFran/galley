import { describe, expect, it } from 'vitest';
import { mainDocument, saveStateLabel } from './session';

describe('mainDocument', () => {
  it('prefers the entry file from .galley.yml when it is visible', () => {
    expect(mainDocument(['index.qmd', 'paper.qmd'], 'paper.qmd')).toBe('paper.qmd');
  });

  it('falls back to index.qmd, then a top-level document', () => {
    expect(mainDocument(['sections/a.qmd', 'index.qmd'], 'hidden.qmd')).toBe('index.qmd');
    expect(mainDocument(['sections/a.qmd', 'paper.qmd', 'notes.md'])).toBe('paper.qmd');
    expect(mainDocument(['sections/b.qmd', 'sections/a.qmd'])).toBe('sections/a.qmd');
    expect(mainDocument(['README.md'])).toBe('README.md');
  });

  it('opens nothing when there is no document', () => {
    expect(mainDocument(['figures/a.png', 'refs.bib'])).toBeUndefined();
    expect(mainDocument([])).toBeUndefined();
  });
});

describe('saveStateLabel', () => {
  it('says everything is saved, how many files are not, or that a save runs', () => {
    expect(saveStateLabel(0, false)).toBe('All changes saved');
    expect(saveStateLabel(1, false)).toBe('1 unsaved file');
    expect(saveStateLabel(2, false)).toBe('2 unsaved files');
    expect(saveStateLabel(2, true)).toBe('Saving…');
  });
});
