import { describe, expect, it } from 'vitest';
import { choose, merge3, resolvedText } from './merge3';

const base = 'Title\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n';

describe('three-way merge', () => {
  it('merges edits to different lines without asking', () => {
    const yours = base.replace('First paragraph.', 'First paragraph, rewritten by you.');
    const theirs = base.replace('Third paragraph.', 'Third paragraph, fixed on main.');
    expect(merge3(base, yours, theirs)).toEqual({
      kind: 'clean',
      text: 'Title\n\nFirst paragraph, rewritten by you.\n\nSecond paragraph.\n\nThird paragraph, fixed on main.\n',
    });
  });

  it('is clean when both sides made the same change', () => {
    const same = base.replace('Second', 'Middle');
    expect(merge3(base, same, same)).toEqual({ kind: 'clean', text: same });
  });

  it('keeps a file without a final line break exact', () => {
    expect(merge3('a\nb', 'a\nb\nc', 'z\na\nb')).toEqual({ kind: 'clean', text: 'z\na\nb\nc' });
  });

  it('reports lines both sides changed as a conflict, with both texts', () => {
    const yours = base.replace('Second paragraph.', 'Second paragraph (yours).');
    const theirs = base.replace('Second paragraph.', 'Second paragraph (theirs).');
    const result = merge3(base, yours, theirs);
    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') return;
    expect(result.regions).toEqual([
      { kind: 'ok', text: 'Title\n\nFirst paragraph.\n\n' },
      { kind: 'conflict', yours: 'Second paragraph (yours).\n', theirs: 'Second paragraph (theirs).\n' },
      { kind: 'ok', text: '\nThird paragraph.\n' },
    ]);
    expect(resolvedText(result.regions)).toBeUndefined();
  });
});

describe('resolving conflicts', () => {
  const regions = [
    { kind: 'ok' as const, text: 'a\n' },
    { kind: 'conflict' as const, yours: 'mine\n', theirs: 'main\n' },
    { kind: 'ok' as const, text: 'z' },
  ];

  it('uses their version, your version or both', () => {
    expect(resolvedText(choose(regions, 1, 'theirs'))).toBe('a\nmain\nz');
    expect(resolvedText(choose(regions, 1, 'yours'))).toBe('a\nmine\nz');
    expect(resolvedText(choose(regions, 1, 'both'))).toBe('a\nmain\nmine\nz');
  });

  it('adds a line break between both versions when needed', () => {
    const tail = [{ kind: 'conflict' as const, yours: 'mine', theirs: 'main' }];
    expect(resolvedText(choose(tail, 0, 'both'))).toBe('main\nmine');
  });

  it('can change a choice before it is applied, and leaves other regions alone', () => {
    const once = choose(regions, 1, 'theirs');
    expect(resolvedText(choose(once, 1, 'yours'))).toBe('a\nmine\nz');
    expect(choose(regions, 0, 'yours')).toBe(regions);
  });
});
