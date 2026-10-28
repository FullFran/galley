import { describe, expect, it } from 'vitest';
import {
  FRAME_JUMP,
  FRAME_SELECTION,
  MAX_SELECTION_TEXT,
  PREVIEW_REVEAL,
  parseFrameMessage,
  parseJumpMessage,
  parseRevealMessage,
  parseSelectionMessage,
  parseSrc,
} from './protocol';

describe('source tags', () => {
  it('parses path:line, splitting at the last colon', () => {
    expect(parseSrc('sections/01-intro.qmd:12')).toEqual({ path: 'sections/01-intro.qmd', line: 12 });
    expect(parseSrc('odd:name.qmd:3')).toEqual({ path: 'odd:name.qmd', line: 3 });
  });

  it.each(['', 'index.qmd', 'index.qmd:0', 'index.qmd:-1', 'index.qmd:1.5', '/etc/passwd:1', '../x.qmd:1', 'a//b.qmd:1', 'a\\b:1', 'a\u0000b:1', 'a\u202Eb:1', `${'a'.repeat(513)}:1`, 'a.qmd:99999999'])(
    'rejects %j',
    (value) => {
      expect(parseSrc(value)).toBeUndefined();
    },
  );
});

describe('selection message', () => {
  const ok = { type: FRAME_SELECTION, text: 'the rate', src: 'index.qmd:3', endSrc: 'index.qmd:4' };

  it('accepts the exact shape', () => {
    expect(parseSelectionMessage(ok)).toEqual(ok);
    expect(parseSelectionMessage({ type: FRAME_SELECTION, text: '', src: '', endSrc: '' })).toEqual({
      type: FRAME_SELECTION,
      text: '',
      src: '',
      endSrc: '',
    });
  });

  it('rejects extra keys, wrong types, bad tags and long text', () => {
    expect(parseSelectionMessage({ ...ok, html: '<b>' })).toBeUndefined();
    expect(parseSelectionMessage({ ...ok, text: 3 })).toBeUndefined();
    expect(parseSelectionMessage({ ...ok, src: '../x:1' })).toBeUndefined();
    expect(parseSelectionMessage({ ...ok, src: '' })).toBeUndefined();
    expect(parseSelectionMessage({ ...ok, text: 'x'.repeat(MAX_SELECTION_TEXT + 1) })).toBeUndefined();
    expect(parseSelectionMessage(null)).toBeUndefined();
    expect(parseSelectionMessage([ok])).toBeUndefined();
  });

  it('is not mistaken for a ready message', () => {
    expect(parseFrameMessage(ok)).toBeUndefined();
  });
});

describe('jump and reveal messages', () => {
  it('validates a jump from the frame', () => {
    expect(parseJumpMessage({ type: FRAME_JUMP, src: 'a.qmd:2' })).toEqual({ type: FRAME_JUMP, src: 'a.qmd:2' });
    expect(parseJumpMessage({ type: FRAME_JUMP, src: 'a.qmd' })).toBeUndefined();
    expect(parseJumpMessage({ type: FRAME_JUMP, src: 'a.qmd:2', x: 1 })).toBeUndefined();
  });

  it('validates a reveal from galley', () => {
    expect(parseRevealMessage({ type: PREVIEW_REVEAL, path: 'a.qmd', line: 4 })).toEqual({ type: PREVIEW_REVEAL, path: 'a.qmd', line: 4 });
    expect(parseRevealMessage({ type: PREVIEW_REVEAL, path: '../a', line: 4 })).toBeUndefined();
    expect(parseRevealMessage({ type: PREVIEW_REVEAL, path: 'a.qmd', line: 0 })).toBeUndefined();
  });
});
