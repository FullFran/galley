import { describe, expect, it } from 'vitest';
import { appendEntry, detectStyle, draftOf, formatEntry, removeEntry, scanBib, updateEntry, valueProblem, type EntryDraft } from './bibFile';

// A file with the quirks real bibliographies have: a leading comment,
// @string and @comment blocks, `%` lines that mention `@`, quoted values,
// `#` concatenation, nested braces, parentheses as delimiters, upper-case
// field names, a tab-indented entry, no trailing comma, and odd spacing.
const QUIRKY = [
  '% Exported by hand. Contact: someone@example.org',
  '@string{ optm = "Opt. Mater." }',
  '',
  '@comment{ this @article{ghost, title={no}} is not an entry }',
  '',
  '@article{benavente2024,',
  '  author  = {Benavente, J. F. and Arquero, O.},',
  '  title   = {Effects of {LiF:Mg,Ti} trapped charge {\\"o} transitions},',
  '  journal = optm,',
  '  year    = 2024,',
  '  month   = jan # "~1",',
  '  doi     = {10.1016/j.optmat.2024.116006}',
  '}',
  '',
  '% @book{commented, title={out}}',
  '@BOOK(chen1997,',
  '\tAUTHOR = "Chen, R. and {McKeever}, S. W. S.",',
  '\tTITLE = "Theory of {T}hermoluminescence",',
  '\tYEAR = 1997,',
  ')',
  '',
  '@misc{ randall1945 , title={Phosphorescence and electron traps}, year={1945}}',
  '',
].join('\n');

const keys = (text: string) => scanBib(text).entries.map((e) => e.key);
const entry = (text: string, key: string) => {
  const found = scanBib(text).entries.find((e) => e.key === key);
  if (!found) throw new Error(`no entry ${key}`);
  return found;
};

/** Everything outside the entry's original byte range is unchanged. */
function onlyEntryChanged(before: string, after: string, key: string) {
  const e = entry(before, key);
  const tail = before.length - e.end;
  expect(after.slice(0, e.start)).toBe(before.slice(0, e.start));
  expect(after.slice(after.length - tail)).toBe(before.slice(e.end));
}

describe('scanBib', () => {
  it('finds entries with their byte ranges, skipping @string, @comment and % lines', () => {
    const scan = scanBib(QUIRKY);
    expect(scan.entries.map((e) => [e.type, e.key])).toEqual([
      ['article', 'benavente2024'],
      ['BOOK', 'chen1997'],
      ['misc', 'randall1945'],
    ]);
    const first = entry(QUIRKY, 'benavente2024');
    expect(QUIRKY.slice(first.start, first.start + 9)).toBe('@article{');
    expect(QUIRKY[first.end - 1]).toBe('}');
    const book = entry(QUIRKY, 'chen1997');
    expect(QUIRKY[book.end - 1]).toBe(')');
  });

  it('reads field values as written: braced, quoted and raw expressions', () => {
    const fields = Object.fromEntries(entry(QUIRKY, 'benavente2024').fields.map((f) => [f.name, [f.kind, f.value]]));
    expect(fields.title).toEqual(['braced', 'Effects of {LiF:Mg,Ti} trapped charge {\\"o} transitions']);
    expect(fields.journal).toEqual(['raw', 'optm']);
    expect(fields.year).toEqual(['raw', '2024']);
    expect(fields.month).toEqual(['raw', 'jan # "~1"']);
    const book = Object.fromEntries(entry(QUIRKY, 'chen1997').fields.map((f) => [f.name, [f.kind, f.value]]));
    expect(book.AUTHOR).toEqual(['quoted', 'Chen, R. and {McKeever}, S. W. S.']);
  });

  it('reports a malformed entry and keeps scanning after it', () => {
    const text = '@article{bad, title = {unclosed\n\n@misc{good, year = 2020}\n';
    const scan = scanBib(text);
    expect(scan.entries.map((e) => e.key)).toEqual(['good']);
    expect(scan.errors.length).toBe(1);
  });
});

describe('detectStyle', () => {
  it('reads indentation, alignment, delimiters and line endings', () => {
    const style = detectStyle('@article{a,\n  author  = {X},\n  title   = {Y},\n  year    = {2020}\n}\n');
    expect(style).toMatchObject({ eol: '\n', indent: '  ', align: true, delim: 'braced', nameCase: 'lower', trailingComma: false });
    const crlf = detectStyle('@article{a,\r\n\tauthor = "X",\r\n\ttitle = "Y",\r\n}\r\n');
    expect(crlf).toMatchObject({ eol: '\r\n', indent: '\t', align: false, delim: 'quoted', trailingComma: true });
  });

  it('falls back to two spaces, braces and LF for an empty file', () => {
    expect(detectStyle('')).toMatchObject({ eol: '\n', indent: '  ', delim: 'braced', nameCase: 'lower' });
  });
});

describe('updateEntry', () => {
  it('changes one value and leaves every other byte of the file as it was', () => {
    const e = entry(QUIRKY, 'benavente2024');
    const draft = draftOf(e);
    draft.fields = draft.fields.map((f) => (f.name === 'doi' ? { ...f, value: '10.1016/j.optmat.2024.999999' } : f));
    const after = updateEntry(QUIRKY, e, draft);
    onlyEntryChanged(QUIRKY, after, 'benavente2024');
    expect(after).toBe(QUIRKY.replace('j.optmat.2024.116006', 'j.optmat.2024.999999'));
  });

  it('keeps raw expressions, macros and nested braces of untouched fields', () => {
    const e = entry(QUIRKY, 'benavente2024');
    const draft = draftOf(e);
    draft.fields = draft.fields.map((f) => (f.name === 'year' ? { ...f, value: '2025' } : f));
    const after = updateEntry(QUIRKY, e, draft);
    expect(after).toContain('  journal = optm,');
    expect(after).toContain('  month   = jan # "~1",');
    expect(after).toContain('{LiF:Mg,Ti} trapped charge {\\"o} transitions}');
    expect(after).toContain('  year    = 2025,');
  });

  it('adds a field in the entry’s own alignment and removes one with its line', () => {
    const e = entry(QUIRKY, 'benavente2024');
    const draft = draftOf(e);
    draft.fields = draft.fields.filter((f) => f.name !== 'month');
    draft.fields.push({ name: 'volume', value: '156' });
    const after = updateEntry(QUIRKY, e, draft);
    onlyEntryChanged(QUIRKY, after, 'benavente2024');
    expect(after).not.toContain('month');
    expect(after).toContain("  doi     = {10.1016/j.optmat.2024.116006},\n  volume  = {156}\n}");
  });

  it('keeps the quoted style, tabs and parentheses of an upper-case entry', () => {
    const e = entry(QUIRKY, 'chen1997');
    const draft = draftOf(e);
    draft.fields = draft.fields.map((f) => (f.name === 'TITLE' ? { ...f, value: 'Theory of {T}hermoluminescence, 2nd ed.' } : f));
    draft.fields.push({ name: 'publisher', value: 'World Scientific' });
    const after = updateEntry(QUIRKY, e, draft);
    onlyEntryChanged(QUIRKY, after, 'chen1997');
    expect(after).toContain('\tTITLE = "Theory of {T}hermoluminescence, 2nd ed.",\n\tYEAR = 1997,\n\tPUBLISHER = "World Scientific",\n)');
  });

  it('renames the key and the type in place', () => {
    const e = entry(QUIRKY, 'randall1945');
    const after = updateEntry(QUIRKY, e, { ...draftOf(e), type: 'article', key: 'randall1945phosphorescence' });
    onlyEntryChanged(QUIRKY, after, 'randall1945');
    expect(after).toContain('@article{ randall1945phosphorescence , title={Phosphorescence and electron traps}, year={1945}}');
  });

  it('writes CRLF in a CRLF file and never mixes line endings', () => {
    const crlf = QUIRKY.replace(/\n/g, '\r\n');
    const e = entry(crlf, 'benavente2024');
    const draft = draftOf(e);
    draft.fields.push({ name: 'note', value: 'Line one\nline two' });
    const after = updateEntry(crlf, e, draft);
    onlyEntryChanged(crlf, after, 'benavente2024');
    expect(after.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(after).toContain('  note    = {Line one\r\nline two}\r\n}');
  });

  it('returns the same text when nothing changed', () => {
    for (const key of keys(QUIRKY)) {
      const e = entry(QUIRKY, key);
      expect(updateEntry(QUIRKY, e, draftOf(e))).toBe(QUIRKY);
    }
  });
});

describe('appendEntry and formatEntry', () => {
  const draft: EntryDraft = { type: 'article', key: 'smith2020deep', fields: [{ name: 'author', value: 'Smith, A.' }, { name: 'title', value: 'Deep {TL}' }, { name: 'year', value: '2020' }] };

  it('appends after a blank line in the file’s style', () => {
    const text = '@article{a,\n  author = {X},\n  year   = {2020},\n}\n';
    const after = appendEntry(text, draft);
    expect(after.startsWith(text)).toBe(true);
    expect(after.slice(text.length)).toBe('\n@article{smith2020deep,\n  author = {Smith, A.},\n  title  = {Deep {TL}},\n  year   = {2020},\n}\n');
  });

  it('adds the missing final line break first, and keeps CRLF', () => {
    const after = appendEntry('@misc{a, year = 2020}', draft);
    expect(after.startsWith('@misc{a, year = 2020}\n\n@article{smith2020deep,')).toBe(true);
    const crlf = appendEntry('@misc{a,\r\n  year = {2020}\r\n}\r\n', draft);
    expect(crlf.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(crlf).toContain('}\r\n\r\n@article{smith2020deep,\r\n');
  });

  it('formats a new entry for an empty file', () => {
    expect(formatEntry(draft, detectStyle(''))).toBe('@article{smith2020deep,\n  author = {Smith, A.},\n  title  = {Deep {TL}},\n  year   = {2020}\n}');
    expect(appendEntry('', draft)).toBe(`${formatEntry(draft, detectStyle(''))}\n`);
  });
});

describe('removeEntry', () => {
  it('removes the entry and one of the blank lines around it', () => {
    const text = '@misc{a, year = 1}\n\n@misc{b, year = 2}\n\n@misc{c, year = 3}\n';
    expect(removeEntry(text, entry(text, 'b'))).toBe('@misc{a, year = 1}\n\n@misc{c, year = 3}\n');
    expect(removeEntry(text, entry(text, 'a'))).toBe('@misc{b, year = 2}\n\n@misc{c, year = 3}\n');
    expect(removeEntry(text, entry(text, 'c'))).toBe('@misc{a, year = 1}\n\n@misc{b, year = 2}\n');
  });

  it('leaves the @string, the comments and the other entries untouched', () => {
    const after = removeEntry(QUIRKY, entry(QUIRKY, 'chen1997'));
    expect(keys(after)).toEqual(['benavente2024', 'randall1945']);
    expect(after).toContain('% @book{commented, title={out}}\n');
    const e = entry(QUIRKY, 'chen1997');
    expect(after).toBe(QUIRKY.slice(0, e.start) + QUIRKY.slice(e.end + 2));
  });
});

describe('valueProblem', () => {
  it('refuses unbalanced braces', () => {
    expect(valueProblem('a {b} c')).toBeUndefined();
    expect(valueProblem('a {b')).toBe('unbalanced');
    expect(valueProblem('a } b {')).toBe('unbalanced');
    expect(valueProblem('50\\% {off}')).toBeUndefined();
  });
});
