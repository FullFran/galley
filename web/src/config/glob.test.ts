import { describe, expect, it } from 'vitest';
import { globError, matchGlob } from './glob';

describe('matchGlob', () => {
  it('matches exact paths', () => {
    expect(matchGlob('index.qmd', 'index.qmd')).toBe(true);
    expect(matchGlob('index.qmd', 'index.md')).toBe(false);
    expect(matchGlob('index.qmd', 'sub/index.qmd')).toBe(false);
  });

  it('keeps * inside one folder', () => {
    expect(matchGlob('sections/*.qmd', 'sections/01-intro.qmd')).toBe(true);
    expect(matchGlob('sections/*.qmd', 'sections/a/01.qmd')).toBe(false);
    expect(matchGlob('sections/*.qmd', 'sections/.qmd')).toBe(false);
    expect(matchGlob('*.qmd', 'index.qmd')).toBe(true);
    expect(matchGlob('*.qmd', 'sections/a.qmd')).toBe(false);
    expect(matchGlob('*', 'README.md')).toBe(true);
  });

  it('lets ** cross folders, including none', () => {
    expect(matchGlob('sections/**/*.qmd', 'sections/a.qmd')).toBe(true);
    expect(matchGlob('sections/**/*.qmd', 'sections/a/b/c.qmd')).toBe(true);
    expect(matchGlob('**/*.bib', 'references.bib')).toBe(true);
    expect(matchGlob('**', 'a/b/c')).toBe(true);
    expect(matchGlob('sections/**', 'sections')).toBe(false);
    expect(matchGlob('sections/**', 'sections/x.qmd')).toBe(true);
  });

  it('matches ? as exactly one character, never a slash', () => {
    expect(matchGlob('sections/0?-*.qmd', 'sections/01-intro.qmd')).toBe(true);
    expect(matchGlob('sections/0?-*.qmd', 'sections/0-intro.qmd')).toBe(false);
    expect(matchGlob('a?b', 'a/b')).toBe(false);
  });

  it('never matches dotfiles or dot folders with wildcards', () => {
    expect(matchGlob('*', '.galley.yml')).toBe(false);
    expect(matchGlob('**', '.galley.yml')).toBe(false);
    expect(matchGlob('**/*.yml', '.github/workflows/ci.yml')).toBe(false);
    expect(matchGlob('?galley.yml', '.galley.yml')).toBe(false);
    expect(matchGlob('.galley.yml', '.galley.yml')).toBe(true);
    expect(matchGlob('.notes/*.md', '.notes/a.md')).toBe(true);
  });

  it('treats other characters literally', () => {
    expect(matchGlob('a+b(1).qmd', 'a+b(1).qmd')).toBe(true);
    expect(matchGlob('a.qmd', 'aXqmd')).toBe(false);
  });

  it('stays fast on patterns built to backtrack', () => {
    const start = Date.now();
    expect(matchGlob(`${'*a'.repeat(30)}b`, 'a'.repeat(200))).toBe(false);
    expect(matchGlob(`${'**/'.repeat(10)}x`, `${'a/'.repeat(60)}y`)).toBe(false);
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe('globError', () => {
  it('accepts plain paths and wildcards', () => {
    for (const p of ['index.qmd', 'sections/*.qmd', 'sections/**/*.qmd', 'STATE.md', 'a?.md', '**']) {
      expect(globError(p)).toBeUndefined();
    }
  });

  it('rejects paths that leave the repository or are absolute', () => {
    expect(globError('/index.qmd')).toMatch(/start with/);
    expect(globError('../other/index.qmd')).toMatch(/\.\./);
    expect(globError('sections/../../x')).toMatch(/\.\./);
    expect(globError('C:/papers/x.qmd')).toMatch(/drive/);
    expect(globError('~/x.qmd')).toMatch(/start with/);
    expect(globError('a\\b.qmd')).toMatch(/backslash/);
  });

  it('rejects empty, odd segments and unsupported syntax', () => {
    expect(globError('')).toMatch(/empty/);
    expect(globError('a//b')).toMatch(/empty folder/);
    expect(globError('./a.qmd')).toMatch(/"\."/);
    expect(globError('sections/')).toMatch(/end with/);
    expect(globError('sections/{a,b}.qmd')).toMatch(/only \*, \*\* and \?/);
    expect(globError('sections/[ab].qmd')).toMatch(/only \*, \*\* and \?/);
    expect(globError('!sections/a.qmd')).toMatch(/only \*, \*\* and \?/);
    expect(globError('a**b')).toMatch(/whole folder name/);
    expect(globError('a\u0000b')).toMatch(/control/);
    expect(globError('x'.repeat(300))).toMatch(/long/);
  });
});
