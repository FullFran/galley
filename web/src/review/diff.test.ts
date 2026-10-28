import { describe, expect, it } from 'vitest';
import { anchorOf, anchorsOf, parsePatch, rightLines } from './diff';

describe('parsePatch', () => {
  it('numbers old and new lines across hunks', () => {
    const patch = [
      '@@ -1,3 +1,3 @@ intro',
      ' # Title',
      '-Old line',
      '+New line',
      ' End',
      '@@ -10,2 +10,3 @@',
      ' a',
      '+b',
      ' c',
      '\\ No newline at end of file',
    ].join('\n');

    expect(parsePatch(patch)).toEqual([
      { kind: 'hunk', text: '@@ -1,3 +1,3 @@ intro' },
      { kind: 'context', text: '# Title', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'Old line', oldLine: 2 },
      { kind: 'add', text: 'New line', newLine: 2 },
      { kind: 'context', text: 'End', oldLine: 3, newLine: 3 },
      { kind: 'hunk', text: '@@ -10,2 +10,3 @@' },
      { kind: 'context', text: 'a', oldLine: 10, newLine: 10 },
      { kind: 'add', text: 'b', newLine: 11 },
      { kind: 'context', text: 'c', oldLine: 11, newLine: 12 },
      { kind: 'meta', text: '\\ No newline at end of file' },
    ]);
  });

  it('anchors deletions on the left and everything else on the right', () => {
    const anchors = parsePatch('@@ -1,2 +1,2 @@\n x\n-y\n+z').map(anchorOf);
    expect(anchors).toEqual([undefined, { side: 'RIGHT', line: 1 }, { side: 'LEFT', line: 2 }, { side: 'RIGHT', line: 2 }]);
    expect(anchorOf({ kind: 'hunk', text: '@@' })).toBeUndefined();
  });
});

describe('rightLines', () => {
  it('returns the new text of a range shown in the patch', () => {
    const patch = '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c';
    expect(rightLines(patch, 1, 2)).toEqual(['a', 'B']);
    expect(rightLines(patch, 3, 4)).toBeUndefined();
  });
});

describe('anchorsOf', () => {
  it('gives context lines both an old (LEFT) and a new (RIGHT) anchor', () => {
    const lines = parsePatch('@@ -3,2 +5,2 @@\n x\n-y\n+z');
    expect(lines.map(anchorsOf)).toEqual([
      [],
      [
        { side: 'RIGHT', line: 5 },
        { side: 'LEFT', line: 3 },
      ],
      [{ side: 'LEFT', line: 4 }],
      [{ side: 'RIGHT', line: 6 }],
    ]);
  });
});
