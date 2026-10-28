import { describe, expect, it } from 'vitest';
import { DEFAULT_RULE, detectKeyRule, keyExample, makeKey, uniqueKey, type KeyFacts } from './keys';

const facts = (key: string, family: string, year: string, title: string): KeyFacts & { key: string } => ({ key, family, year, title });

describe('detectKeyRule', () => {
  it('detects authorYEAR', () => {
    const rule = detectKeyRule([
      facts('benavente2024', 'Benavente', '2024', 'Effects of trapped charge'),
      facts('randall1945', 'Randall', '1945', 'Phosphorescence and electron traps'),
      facts('chen1997', 'Chen', '1997', 'Theory of thermoluminescence'),
    ]);
    expect(keyExample(rule)).toBe('author2020');
  });

  it('detects authorYEARword (Google Scholar) with a disambiguation letter', () => {
    const rule = detectKeyRule([
      facts('randall1945phosphorescence', 'Randall', '1945', 'Phosphorescence and electron traps'),
      facts('chen1997theory', 'Chen', '1997', 'The theory of thermoluminescence'),
      facts('chen1997theorya', 'Chen', '1997', 'Theory, again'),
    ]);
    expect(keyExample(rule)).toBe('author2020word');
  });

  it('detects Author_YEAR (Crossref) and Author:YEAR', () => {
    expect(keyExample(detectKeyRule([facts('Benavente_2024', 'Benavente', '2024', 'x'), facts('Chen_1997', 'Chen', '1997', 'y')]))).toBe('Author_2020');
    expect(keyExample(detectKeyRule([facts('Benavente:2024', 'Benavente', '2024', 'x'), facts('Chen:1997', 'Chen', '1997', 'y')]))).toBe('Author:2020');
  });

  it('transliterates accents and drops spaces and hyphens in names', () => {
    const rule = detectKeyRule([facts('garciamarquez2001', 'García Márquez', '2001', 'x'), facts('bereng2020', 'Bereng', '2020', 'y')]);
    expect(makeKey(rule, { family: 'Berenguer-Antequera', year: '2024', title: 'x' })).toBe('berenguerantequera2024');
  });

  it('falls back to authorYEARword when keys follow no pattern', () => {
    expect(detectKeyRule([facts('ref1', 'Smith', '2020', 'x'), facts('ref2', 'Jones', '2021', 'y')])).toEqual(DEFAULT_RULE);
    expect(detectKeyRule([])).toEqual(DEFAULT_RULE);
  });
});

describe('makeKey', () => {
  it('skips stop words for the title word and handles missing parts', () => {
    expect(makeKey(DEFAULT_RULE, { family: 'van der Waals', year: '1873', title: 'On the continuity of the gaseous state' })).toBe('vanderwaals1873continuity');
    expect(makeKey(DEFAULT_RULE, { family: undefined, year: undefined, title: 'A study' })).toBe('anonstudy');
    expect(makeKey(DEFAULT_RULE, { family: 'Ünal', year: '2020', title: '' })).toBe('unal2020');
  });
});

describe('uniqueKey', () => {
  it('adds a, b, c… when the key is taken, ignoring case', () => {
    expect(uniqueKey('chen1997', new Set())).toBe('chen1997');
    expect(uniqueKey('chen1997', new Set(['Chen1997']))).toBe('chen1997a');
    expect(uniqueKey('chen1997', new Set(['chen1997', 'chen1997a']))).toBe('chen1997b');
  });
});
