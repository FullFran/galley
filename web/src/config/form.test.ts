import { describe, expect, it } from 'vitest';
import { candidateFiles, checkDraft, coveredBy, parseAccept, togglePattern } from './form';
import type { GalleyConfig } from './schema';

const draft = (editable: string[]): GalleyConfig => ({ version: 1, editable, uploads: [], labels: {}, preview: { autoCompile: false } });

describe('settings form helpers', () => {
  it('offers the paper documents as candidates, never hidden or config files', () => {
    const files = ['.galley.yml', '.github/x.md', '_quarto.yml', 'index.qmd', 'STATE.md', 'refs.bib', 'run.py', 'figures/a.png'];
    expect(candidateFiles(files)).toEqual(['index.qmd', 'STATE.md', 'refs.bib']);
  });

  it('names the pattern that already covers a file', () => {
    expect(coveredBy('sections/a.qmd', ['index.qmd', 'sections/*.qmd'])).toBe('sections/*.qmd');
    expect(coveredBy('index.qmd', ['index.qmd'])).toBeUndefined();
    expect(coveredBy('STATE.md', ['index.qmd'])).toBeUndefined();
  });

  it('adds and removes patterns without duplicates', () => {
    expect(togglePattern(draft(['index.qmd']), 'STATE.md', true).editable).toEqual(['index.qmd', 'STATE.md']);
    expect(togglePattern(draft(['index.qmd']), 'index.qmd', true).editable).toEqual(['index.qmd']);
    expect(togglePattern(draft(['index.qmd', 'STATE.md']), 'index.qmd', false).editable).toEqual(['STATE.md']);
  });

  it('reads accepted types from free text', () => {
    expect(parseAccept('png, JPG  svg,,')).toEqual(['png', 'JPG', 'svg']);
  });

  it('checks a draft exactly as the saved file will be checked', () => {
    expect(checkDraft(draft(['index.qmd'])).problems).toEqual([]);
    expect(checkDraft(draft(['../x'])).problems[0]?.severity).toBe('error');
    expect(checkDraft(draft(['index.qmd'])).text).toBe('version: 1\neditable:\n  - index.qmd\npreview:\n  auto_compile: false\n');
  });
});
