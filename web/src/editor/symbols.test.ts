import { describe, expect, it } from 'vitest';
import { SYMBOL_GROUPS, inMath, planSymbolInsert, pushRecent, readRecent, searchSymbols, symbolById, RECENT_LIMIT } from './symbols';

describe('symbol catalog', () => {
  it('has the expected groups, each with symbols and unique ids', () => {
    const groups = SYMBOL_GROUPS.map((g) => g.id);
    expect(groups).toEqual(['greek', 'operators', 'relations', 'arrows', 'accents', 'delimiters', 'constructs']);
    const ids = SYMBOL_GROUPS.flatMap((g) => g.symbols.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of SYMBOL_GROUPS) expect(g.symbols.length).toBeGreaterThan(3);
    expect(symbolById('\\alpha')?.insert).toBe('\\alpha');
    expect(symbolById('\\frac{}{}')?.insert).toBe('\\frac{}{}');
  });
});

describe('searchSymbols', () => {
  it('returns every symbol for an empty query, grouped in catalog order', () => {
    const all = searchSymbols('');
    expect(all.map((g) => g.id)).toEqual(SYMBOL_GROUPS.map((g) => g.id));
  });

  it('matches the command and the name, case-insensitively, without the backslash', () => {
    const hits = searchSymbols('ALPHA').flatMap((g) => g.symbols.map((s) => s.id));
    expect(hits).toContain('\\alpha');
    expect(searchSymbols('\\leq').flatMap((g) => g.symbols.map((s) => s.id))).toContain('\\leq');
    expect(searchSymbols('fraction').flatMap((g) => g.symbols.map((s) => s.id))).toContain('\\frac{}{}');
  });

  it('ranks commands that start with the query first and drops empty groups', () => {
    const groups = searchSymbols('sum');
    expect(groups.every((g) => g.symbols.length > 0)).toBe(true);
    expect(groups[0]?.symbols[0]?.id.startsWith('\\sum')).toBe(true);
    expect(searchSymbols('zzzz-nothing')).toEqual([]);
  });
});

describe('inMath', () => {
  it('sees inline and display math', () => {
    expect(inMath('a $x + ', 7)).toBe(true);
    expect(inMath('a $x$ b', 7)).toBe(false);
    expect(inMath('$$\n\\int ', 8)).toBe(true);
    expect(inMath('$$x$$ after', 11)).toBe(false);
    expect(inMath('\\(x ', 4)).toBe(true);
    expect(inMath('\\[x\\] y', 7)).toBe(false);
  });

  it('ignores escaped dollars, code spans and code blocks', () => {
    expect(inMath('costs \\$5 and ', 14)).toBe(false);
    expect(inMath('`$` then ', 9)).toBe(false);
    expect(inMath('```\n$x\n```\nnow ', 15)).toBe(false);
  });
});

describe('planSymbolInsert', () => {
  it('wraps in $…$ outside math and puts the caret after the symbol', () => {
    expect(planSymbolInsert('Let ', 4, 4, '\\alpha')).toEqual({ from: 4, to: 4, insert: '$\\alpha$', caret: 11 });
  });

  it('inserts bare inside math', () => {
    expect(planSymbolInsert('$x = $', 5, 5, '\\beta')).toEqual({ from: 5, to: 5, insert: '\\beta', caret: 10 });
  });

  it('puts the caret in the first empty braces of a construct', () => {
    expect(planSymbolInsert('$$', 1, 1, '\\frac{}{}')).toEqual({ from: 1, to: 1, insert: '\\frac{}{}', caret: 7 });
    expect(planSymbolInsert('', 0, 0, '\\sum_{}^{}')).toEqual({ from: 0, to: 0, insert: '$\\sum_{}^{}$', caret: 7 });
  });

  it('moves a selection into the first braces', () => {
    expect(planSymbolInsert('$ab$', 1, 3, '\\hat{}')).toEqual({ from: 1, to: 3, insert: '\\hat{ab}', caret: 9 });
    expect(planSymbolInsert('x', 0, 1, '\\alpha')).toEqual({ from: 0, to: 1, insert: '$\\alpha$', caret: 7 });
  });
});

describe('recent symbols', () => {
  const store = () => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      data,
    };
  };

  it('keeps the most recent first, without duplicates, up to the limit', () => {
    const s = store();
    pushRecent(s, '\\alpha');
    pushRecent(s, '\\beta');
    pushRecent(s, '\\alpha');
    expect(readRecent(s)).toEqual(['\\alpha', '\\beta']);
    for (const g of SYMBOL_GROUPS[0]?.symbols ?? []) pushRecent(s, g.id);
    expect(readRecent(s)).toHaveLength(RECENT_LIMIT);
  });

  it('drops unknown or malformed entries and survives broken storage', () => {
    const s = store();
    s.setItem('galley.symbols.recent', JSON.stringify(['\\alpha', '<script>', 3]));
    expect(readRecent(s)).toEqual(['\\alpha']);
    s.setItem('galley.symbols.recent', '{nope');
    expect(readRecent(s)).toEqual([]);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readRecent(broken)).toEqual([]);
    expect(() => pushRecent(broken, '\\alpha')).not.toThrow();
    expect(readRecent(undefined)).toEqual([]);
  });
});
