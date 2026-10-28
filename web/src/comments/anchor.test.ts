import { describe, expect, it } from 'vitest';
import { QUOTE_CONTEXT, buildAnchor, lineRangeOffsets } from './anchor';
import { mapPreviewSelection } from './previewMap';
import { locateAnchor, applySuggestion } from './suggestion';

const doc = ['# Title', '', 'The quick brown fox jumps over the lazy dog, and then it runs far away.', 'Second line here.', ''].join('\n');
const at = (needle: string) => doc.indexOf(needle);

describe('buildAnchor', () => {
  it('anchors a selection inside one line with 1-based inclusive columns and context', () => {
    const from = at('brown');
    const result = buildAnchor(doc, from, from + 'brown fox'.length);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.range).toEqual({ startLine: 3, endLine: 3, startColumn: 11, endColumn: 19 });
    expect(result.quote.exact).toBe('brown fox');
    expect(result.quote.prefix).toBe(doc.slice(Math.max(0, from - QUOTE_CONTEXT), from));
    expect(result.quote.suffix).toBe(doc.slice(from + 9, from + 9 + QUOTE_CONTEXT));
  });

  it('uses the whole line for an empty selection, without columns', () => {
    const result = buildAnchor(doc, at('Second') + 3, at('Second') + 3);
    expect(result).toMatchObject({ kind: 'ok', range: { startLine: 4, endLine: 4 }, quote: { exact: 'Second line here.' } });
    if (result.kind === 'ok') expect(result.range.startColumn).toBeUndefined();
  });

  it('spans several lines and does not end on the start of a following line', () => {
    const from = at('lazy');
    const to = at('Second'); // at column 0 of line 4
    const result = buildAnchor(doc, from, to);
    expect(result).toMatchObject({ kind: 'ok', range: { startLine: 3, endLine: 3 } });
    const two = buildAnchor(doc, from, at('line here'));
    expect(two).toMatchObject({ kind: 'ok', range: { startLine: 3, endLine: 4, startColumn: from - at('The') + 1, endColumn: 7 } });
    if (two.kind === 'ok') expect(two.quote.exact).toBe(doc.slice(from, at('line here')));
  });

  it('keeps short context at the start and end of the file', () => {
    const result = buildAnchor(doc, 0, 1);
    expect(result).toMatchObject({ kind: 'ok', quote: { exact: '#', prefix: '' } });
  });

  it('refuses an empty line, a blank quote and text the server would reject', () => {
    expect(buildAnchor(doc, at('\n\n') + 1, at('\n\n') + 1).kind).toBe('empty');
    const bidi = 'a\u202Eb';
    expect(buildAnchor(bidi, 0, 3).kind).toBe('unsupported');
    expect(buildAnchor('x'.repeat(25_000), 0, 25_000).kind).toBe('too-long');
  });

  it('drops bidi controls from the context instead of the quote', () => {
    const text = 'ab\u202Ecd target ef\u2066gh';
    const result = buildAnchor(text, text.indexOf('target'), text.indexOf('target') + 6);
    expect(result).toMatchObject({ kind: 'ok', quote: { exact: 'target', prefix: 'cd ', suffix: ' ef' } });
  });

  it('never splits a surrogate pair in the context', () => {
    const text = `${'😀'.repeat(20)}X`;
    const result = buildAnchor(text, text.length - 1, text.length);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.quote.prefix.startsWith('\uDE00')).toBe(false);
  });
});

describe('lineRangeOffsets', () => {
  it('maps a whole-line range to offsets without the final newline', () => {
    expect(lineRangeOffsets(doc, { startLine: 4, endLine: 4 })).toEqual({ from: at('Second'), to: at('Second') + 'Second line here.'.length });
    expect(lineRangeOffsets(doc, { startLine: 3, endLine: 3, startColumn: 11, endColumn: 19 })).toEqual({ from: at('brown'), to: at('brown') + 9 });
    expect(lineRangeOffsets(doc, { startLine: 99, endLine: 99 })).toBeUndefined();
  });
});

describe('mapPreviewSelection', () => {
  const source = ['# Methods', '', 'We measured the *rate* of', 'decay over `time`.', '', 'Another paragraph.'].join('\n');

  it('finds rendered text in the source block, across Markdown and line breaks', () => {
    const hit = mapPreviewSelection(source, { startLine: 3, endLine: 4, text: 'the rate of decay' });
    expect(hit?.exact).toBe(true);
    expect(source.slice(hit?.from, hit?.to)).toBe('the *rate* of\ndecay');
  });

  it('finds plain text exactly', () => {
    const hit = mapPreviewSelection(source, { startLine: 6, endLine: 6, text: 'Another' });
    expect(hit).toEqual({ from: source.indexOf('Another'), to: source.indexOf('Another') + 7, exact: true });
  });

  it('falls back to the whole block when the text cannot be found', () => {
    const hit = mapPreviewSelection(source, { startLine: 3, endLine: 4, text: '∫ rendered maths' });
    expect(hit?.exact).toBe(false);
    expect(source.slice(hit?.from, hit?.to)).toBe('We measured the *rate* of\ndecay over `time`.');
  });

  it('rejects lines outside the file', () => {
    expect(mapPreviewSelection(source, { startLine: 40, endLine: 41, text: 'x' })).toBeUndefined();
  });
});

describe('suggestions', () => {
  const anchor = (over: Partial<Parameters<typeof locateAnchor>[1]> = {}) => ({
    startLine: 3,
    endLine: 3,
    startColumn: 11,
    endColumn: 19,
    quote: { exact: 'brown fox', prefix: 'The quick ', suffix: ' jumps' },
    ...over,
  });

  it('applies the replacement to the anchored range', () => {
    expect(applySuggestion(doc, anchor(), 'red cat')).toBe(doc.replace('brown fox', 'red cat'));
  });

  it('follows the quote when lines moved', () => {
    const moved = `Inserted line\n${doc}`;
    expect(applySuggestion(moved, anchor(), 'red cat')).toBe(moved.replace('brown fox', 'red cat'));
  });

  it('uses prefix and suffix to choose between repeated quotes', () => {
    const text = 'a brown fox b\nThe quick brown fox jumps';
    expect(locateAnchor(text, anchor({ startLine: 9, endLine: 9 }))).toEqual({ from: text.lastIndexOf('brown fox'), to: text.lastIndexOf('brown fox') + 9 });
  });

  it('refuses when the quoted text is gone', () => {
    expect(applySuggestion(doc.replace('brown fox', 'grey wolf'), anchor(), 'red cat')).toBeUndefined();
  });
});
