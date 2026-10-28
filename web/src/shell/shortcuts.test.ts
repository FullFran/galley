import { describe, expect, it } from 'vitest';
import { matchShortcut, SHORTCUTS } from './shortcuts';

const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('keyboard shortcuts', () => {
  it('maps Ctrl/Cmd+B to the sidebar, outside text fields only', () => {
    expect(matchShortcut(key('b', { ctrlKey: true }), false)).toBe('toggleSidebar');
    expect(matchShortcut(key('B', { metaKey: true }), false)).toBe('toggleSidebar');
    expect(matchShortcut(key('b', { ctrlKey: true }), true)).toBeUndefined();
    expect(matchShortcut(key('b', { ctrlKey: true, shiftKey: true }), false)).toBeUndefined();
  });

  it('maps Ctrl/Cmd+Enter to recompile and Ctrl/Cmd+S to save for review, also while typing', () => {
    expect(matchShortcut(key('Enter', { ctrlKey: true }), true)).toBe('recompile');
    expect(matchShortcut(key('Enter', { metaKey: true }), false)).toBe('recompile');
    expect(matchShortcut(key('s', { ctrlKey: true }), true)).toBe('save');
    expect(matchShortcut(key('S', { metaKey: true }), false)).toBe('save');
    expect(matchShortcut(key('s', { ctrlKey: true, altKey: true }), false)).toBeUndefined();
  });

  it('maps ? to the shortcuts dialog, never while typing', () => {
    expect(matchShortcut(key('?', { shiftKey: true }), false)).toBe('help');
    expect(matchShortcut(key('?', { shiftKey: true }), true)).toBeUndefined();
    expect(matchShortcut(key('?', { ctrlKey: true }), false)).toBeUndefined();
  });

  it('ignores plain keys', () => {
    for (const k of ['b', 's', 'Enter', 'Escape', '/']) expect(matchShortcut(key(k), false)).toBeUndefined();
  });

  it('lists every action once for the shortcuts dialog', () => {
    const actions = SHORTCUTS.map((s) => s.action);
    expect(new Set(actions)).toEqual(new Set(['toggleSidebar', 'recompile', 'save', 'help']));
    expect(actions.length).toBe(4);
  });
});
