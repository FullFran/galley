import { describe, expect, it } from 'vitest';
import { nextMenuIndex } from './menuNav';

const all = [true, true, true];

describe('menu keyboard navigation', () => {
  it('moves down and up, wrapping around', () => {
    expect(nextMenuIndex('ArrowDown', 0, all)).toBe(1);
    expect(nextMenuIndex('ArrowDown', 2, all)).toBe(0);
    expect(nextMenuIndex('ArrowUp', 0, all)).toBe(2);
    expect(nextMenuIndex('ArrowUp', -1, all)).toBe(2);
    expect(nextMenuIndex('ArrowDown', -1, all)).toBe(0);
  });

  it('jumps to the first and last item', () => {
    expect(nextMenuIndex('Home', 1, all)).toBe(0);
    expect(nextMenuIndex('End', 0, all)).toBe(2);
  });

  it('skips disabled items', () => {
    const items = [true, false, true];
    expect(nextMenuIndex('ArrowDown', 0, items)).toBe(2);
    expect(nextMenuIndex('ArrowUp', 2, items)).toBe(0);
    expect(nextMenuIndex('End', 0, [true, true, false])).toBe(1);
    expect(nextMenuIndex('Home', 2, [false, true, true])).toBe(1);
  });

  it('ignores other keys and empty menus', () => {
    expect(nextMenuIndex('a', 0, all)).toBeUndefined();
    expect(nextMenuIndex('ArrowDown', 0, [])).toBeUndefined();
    expect(nextMenuIndex('ArrowDown', 0, [false, false])).toBeUndefined();
  });
});
