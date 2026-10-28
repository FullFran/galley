import { describe, expect, it } from 'vitest';
import { detectConvention, sectionPath } from './convention';
import { readIncludes, type EntryInclude } from './includes';
import { slugify } from './slug';

describe('slugify', () => {
  it('transliterates with NFKD and keeps only a-z, 0-9 and hyphens', () => {
    expect(slugify('Métodos y Análisis')).toBe('metodos-y-analisis');
    expect(slugify('Straße & Œuvre: ½ done')).toBe('strasse-oeuvre-1-2-done');
    expect(slugify('  --Hello,   World!--  ')).toBe('hello-world');
  });

  it('cuts at most 40 characters, on a word boundary when it can', () => {
    const slug = slugify('A very long section title about thermoluminescence glow curves and kinetics');
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toBe('a-very-long-section-title-about');
    expect(slugify('x'.repeat(60))).toBe('x'.repeat(40));
  });

  it('gives an empty slug when nothing is left', () => {
    expect(slugify('日本語')).toBe('');
    expect(slugify('!!!')).toBe('');
  });
});

const inc = (path: string, line: number): EntryInclude => ({ raw: path, path, line });

describe('detectConvention', () => {
  it('detects a numbered folder convention', () => {
    const c = detectConvention('index.qmd', [inc('sections/01-introduction.qmd', 5), inc('sections/02-model.qmd', 7)]);
    expect(c).toMatchObject({ folder: 'sections/', underscore: false, numbered: { width: 2, sep: '-' }, ext: '.qmd' });
  });

  it('detects underscore partials at the root and .md files', () => {
    expect(detectConvention('index.qmd', [inc('_intro.qmd', 1), inc('_methods.qmd', 2)])).toMatchObject({
      folder: '',
      underscore: true,
      ext: '.qmd',
    });
    expect(detectConvention('index.qmd', [inc('chapters/intro.md', 1), inc('chapters/data.md', 2)])).toMatchObject({
      folder: 'chapters/',
      underscore: false,
      ext: '.md',
    });
    expect(detectConvention('index.qmd', [inc('chapters/intro.md', 1)]).numbered).toBeUndefined();
  });

  it('falls back to sections/_slug.qmd when the entry has no includes', () => {
    expect(detectConvention('index.qmd', [])).toMatchObject({ folder: 'sections/', underscore: true, ext: '.qmd' });
  });

  it('reads folders relative to an entry in a subfolder', () => {
    const { includes } = readIncludes('paper/index.qmd', '{{< include parts/a.qmd >}}\n{{< include parts/b.qmd >}}\n') as {
      includes: EntryInclude[];
    };
    expect(includes.map((i) => i.path)).toEqual(['paper/parts/a.qmd', 'paper/parts/b.qmd']);
    expect(detectConvention('paper/index.qmd', includes).folder).toBe('paper/parts/');
  });
});

describe('sectionPath', () => {
  const numbered = detectConvention('index.qmd', [
    inc('sections/01-introduction.qmd', 1),
    inc('sections/02-model.qmd', 2),
    inc('sections/03-results.qmd', 3),
  ]);
  const files = ['sections/01-introduction.qmd', 'sections/02-model.qmd', 'sections/03-results.qmd'];

  it('never renumbers: between two numbered files it adds a letter to the previous number', () => {
    expect(sectionPath('methods', numbered, { prev: 'sections/02-model.qmd', next: 'sections/03-results.qmd' }, files)).toBe(
      'sections/02a-methods.qmd',
    );
    expect(
      sectionPath('methods', numbered, { prev: 'sections/02-model.qmd', next: 'sections/03-results.qmd' }, [...files, 'sections/02a-data.qmd']),
    ).toBe('sections/02b-methods.qmd');
    expect(
      sectionPath('more', numbered, { prev: 'sections/02a-data.qmd', next: 'sections/03-results.qmd' }, [...files, 'sections/02a-data.qmd']),
    ).toBe('sections/02b-more.qmd');
  });

  it('takes the next free number at the end and the one before the first at the start', () => {
    expect(sectionPath('discussion', numbered, { prev: 'sections/03-results.qmd' }, files)).toBe('sections/04-discussion.qmd');
    expect(sectionPath('preface', numbered, { next: 'sections/01-introduction.qmd' }, files)).toBe('sections/00-preface.qmd');
  });

  it('uses plain slugs without a numeric convention, and avoids a leading digit', () => {
    const plain = detectConvention('index.qmd', []);
    expect(sectionPath('methods', plain, {}, [])).toBe('sections/_methods.qmd');
    expect(sectionPath('2d-model', plain, {}, [])).toBe('sections/_section-2d-model.qmd');
    expect(sectionPath('', plain, {}, [])).toBe('sections/_section.qmd');
    const root = detectConvention('index.qmd', [inc('intro.qmd', 1), inc('data.qmd', 2)]);
    expect(sectionPath('methods', root, {}, [])).toBe('methods.qmd');
  });

  it('allows a leading digit when the numeric prefix is the convention', () => {
    expect(sectionPath('2d-model', numbered, { prev: 'sections/03-results.qmd' }, files)).toBe('sections/04-2d-model.qmd');
  });
});
