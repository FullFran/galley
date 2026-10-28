import { describe, expect, it } from 'vitest';
import { rawExpressionOk } from './bibFile';
import { draftFacts, readLibrary } from './library';
import { validateDraft } from './validate';

const lib = readLibrary([{ path: 'r.bib', text: '@book{chen1997, author = {Chen, R.}, year = 1997}\n' }]);

describe('validateDraft', () => {
  it('accepts a good draft and the entry keeping its own key', () => {
    expect(validateDraft({ type: 'article', key: 'smith2020', fields: [{ name: 'title', value: 'A {B}' }] }, lib)).toEqual([]);
    expect(validateDraft({ type: 'book', key: 'chen1997', fields: [] }, lib, 'chen1997')).toEqual([]);
  });

  it('reports empty, invalid and taken keys, bad and repeated field names, unbalanced braces', () => {
    expect(validateDraft({ type: 'misc', key: ' ', fields: [] }, lib).map((p) => p.kind)).toEqual(['key-empty']);
    expect(validateDraft({ type: 'misc', key: 'a b', fields: [] }, lib).map((p) => p.kind)).toEqual(['key-invalid']);
    expect(validateDraft({ type: 'misc', key: 'Chen1997', fields: [] }, lib).map((p) => p.kind)).toEqual(['key-taken']);
    const fields = [
      { name: '1st', value: 'x' },
      { name: 'title', value: 'x' },
      { name: 'Title', value: '{x' },
    ];
    expect(validateDraft({ type: 'misc', key: 'k', fields }, lib)).toEqual([
      { kind: 'field-name', index: 0, name: '1st' },
      { kind: 'field-twice', index: 2, name: 'Title' },
      { kind: 'unbalanced', index: 2, name: 'Title' },
    ]);
  });
});

describe('helpers', () => {
  it('knows which values can stay unquoted', () => {
    expect(rawExpressionOk('2024')).toBe(true);
    expect(rawExpressionOk('jan # "~1"')).toBe(true);
    expect(rawExpressionOk('Optical Materials')).toBe(false);
    expect(rawExpressionOk('')).toBe(false);
  });

  it('reads author, year and title of a draft for its key', () => {
    expect(draftFacts({ type: 'article', key: '', fields: [{ name: 'author', value: 'van der Waals, J. D.' }, { name: 'year', value: '1873' }, { name: 'title', value: 'On the {C}ontinuity' }] })).toEqual({
      family: 'Waals',
      year: '1873',
      title: 'On the Continuity',
    });
  });
});
