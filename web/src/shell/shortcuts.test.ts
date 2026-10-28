import { describe, expect, it } from 'vitest';
import { keyOrigin, matchShortcut, SHORTCUTS, typingAt, typingInField } from './shortcuts';

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

  describe('typing detection across the editor shadow root', () => {
    // At window level a key event from inside the editor's shadow root is
    // retargeted to the shadow host, a plain <div>; the real origin is the
    // first entry of composedPath().
    const host = { tagName: 'DIV', isContentEditable: false } as unknown as EventTarget;
    const content = { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget;
    const vimPrompt = { tagName: 'INPUT', isContentEditable: false } as unknown as EventTarget;
    const fromShadow = (origin: EventTarget) => ({ target: host, composedPath: () => [origin, host] });

    it('finds the element the key came from, not the shadow host', () => {
      expect(keyOrigin(fromShadow(content))).toBe(content);
      expect(keyOrigin({ target: host })).toBe(host);
      expect(keyOrigin({ target: host, composedPath: () => [] })).toBe(host);
    });

    it('treats the editor text and the Vim command line as typing', () => {
      expect(typingInField(host)).toBe(false);
      expect(typingAt(fromShadow(content))).toBe(true);
      expect(typingAt(fromShadow(vimPrompt))).toBe(true);
      expect(typingAt({ target: host })).toBe(false);
      expect(typingInField(null)).toBe(false);
    });

    it('leaves ? and Ctrl/Cmd+B to the editor (Vim search, bold) but keeps Ctrl/Cmd+S', () => {
      const typing = typingAt(fromShadow(content));
      expect(matchShortcut(key('?', { shiftKey: true }), typing)).toBeUndefined();
      expect(matchShortcut(key('b', { ctrlKey: true }), typing)).toBeUndefined();
      expect(matchShortcut(key('s', { ctrlKey: true }), typing)).toBe('save');
      expect(matchShortcut(key('?', { shiftKey: true }), typingAt({ target: host }))).toBe('help');
    });
  });
});
