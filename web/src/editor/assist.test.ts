import { describe, expect, it } from 'vitest';
import { buildIndex } from './projectIndex';
import { completeAt } from './complete';
import { findRefProblems } from './diagnose';
import { definitionAt } from './definition';
import { PROJECT } from './testProject';

const index = buildIndex(PROJECT);
/** Text with `|` marking the cursor. */
const at = (marked: string) => ({ text: marked.replace('|', ''), pos: marked.indexOf('|') });

describe('autocomplete', () => {
  it('offers bib keys with author, year and title, and crossref labels with number and caption on @', () => {
    const { text, pos } = at('As shown by @sm|');
    const result = completeAt(text, pos, index, 'sections/intro.qmd');
    expect(result?.from).toBe(text.indexOf('@') + 1);
    const smith = result?.items.find((i) => i.label === 'smith2020');
    expect(smith).toMatchObject({ type: 'citation', detail: 'Smith & Jones 2020', info: 'Glow TL curves' });
    const fig = result?.items.find((i) => i.label === 'fig-scheme');
    expect(fig).toMatchObject({ type: 'crossref', kind: 'fig', number: '1', info: 'Energy-band scheme.' });
    expect(result?.items.some((i) => i.label === 'sec-intro')).toBe(true);
  });

  it('works inside brackets and after a dash, but not in an e-mail address', () => {
    expect(completeAt('[@|', 2, index, 'a.qmd')?.from).toBe(2);
    expect(completeAt('see [-@', 7, index, 'a.qmd')?.from).toBe(7);
    expect(completeAt('ana@uni', 7, index, 'a.qmd')).toBeNull();
  });

  it('completes include paths from the repository tree, relative to the including file when possible', () => {
    const { text, pos } = at('{{< include sec|');
    const root = completeAt(text, pos, index, 'index.qmd');
    expect(root?.from).toBe(text.indexOf('sec'));
    expect(root?.items.map((i) => i.label)).toEqual(['notes.md', 'sections/intro.qmd', 'sections/model.qmd', 'sections/unused.qmd']);
    const nested = completeAt('{{< include ', 12, index, 'sections/intro.qmd');
    expect(nested?.items.map((i) => i.label)).toContain('model.qmd');
    expect(nested?.items.map((i) => i.label)).not.toContain('intro.qmd');
  });

  it('completes figure paths inside ![](…) relative to the entry document', () => {
    const { text, pos } = at('![Caption](fig|');
    const result = completeAt(text, pos, index, 'sections/model.qmd');
    expect(result?.from).toBe(text.indexOf('fig'));
    expect(result?.items.map((i) => i.label)).toEqual(['figures/plot.svg', 'figures/scheme.png']);
    expect(result?.items[0]?.type).toBe('image');
  });

  it('offers nothing elsewhere', () => {
    expect(completeAt('plain text', 5, index, 'a.qmd')).toBeNull();
  });
});

describe('inline warnings', () => {
  it('flags unknown citation keys and dangling crossrefs with their range', () => {
    const text = 'See @smith2020 and @nobody2001, @fig-scheme, @fig-missing; mail ana@uni.es.';
    const problems = findRefProblems(text, index);
    expect(problems).toEqual([
      { from: text.indexOf('@nobody'), to: text.indexOf('@nobody') + '@nobody2001'.length, kind: 'unknown-citation', key: 'nobody2001' },
      { from: text.indexOf('@fig-missing'), to: text.indexOf('@fig-missing') + '@fig-missing'.length, kind: 'dangling-crossref', key: 'fig-missing' },
    ]);
  });

  it('ignores front matter, code blocks and inline code', () => {
    const text = '---\nauthor: "@nobody"\n---\n\n`@nope` text\n\n```\n@alsonot\n```\n';
    expect(findRefProblems(text, index)).toEqual([]);
  });

  it('drops trailing punctuation from a key', () => {
    expect(findRefProblems('As @smith2020.', index)).toEqual([]);
  });
});

describe('go to definition', () => {
  it('opens the file of an include', () => {
    const text = 'x\n{{< include sections/model.qmd >}}\n';
    expect(definitionAt(text, text.indexOf('model'), index, 'index.qmd')).toEqual({ kind: 'file', path: 'sections/model.qmd' });
  });

  it('opens the image of a figure path, finding the extension like the preview', () => {
    const text = '![Energy-band scheme.](figures/scheme){#fig-scheme}';
    expect(definitionAt(text, text.indexOf('scheme)'), index, 'sections/model.qmd')).toEqual({ kind: 'image', path: 'figures/scheme.png' });
  });

  it('jumps to where a crossref label is defined, in whichever file', () => {
    const text = 'see @fig-scheme here';
    expect(definitionAt(text, text.indexOf('scheme'), index, 'sections/intro.qmd')).toEqual({
      kind: 'label',
      id: 'fig-scheme',
      path: 'sections/model.qmd',
      line: 3,
    });
  });

  it('opens the bib file at the entry of a citation key', () => {
    const text = '[@doe1999, p. 3]';
    expect(definitionAt(text, 4, index, 'a.qmd')).toEqual({ kind: 'citation', key: 'doe1999', path: 'references.bib', line: 9 });
  });

  it('reports a target that does not exist, and nothing on plain text', () => {
    expect(definitionAt('@fig-gone', 3, index, 'a.qmd')).toEqual({ kind: 'missing', name: 'fig-gone' });
    expect(definitionAt('{{< include nope.qmd >}}', 14, index, 'a.qmd')).toEqual({ kind: 'missing', name: 'nope.qmd' });
    expect(definitionAt('just words', 3, index, 'a.qmd')).toBeUndefined();
  });
});
