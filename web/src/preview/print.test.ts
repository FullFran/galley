import { describe, expect, it } from 'vitest';
import { MAX_PRINT_NOTE, PREVIEW_PRINT, parsePrintMessage, parseRenderMessage, parseScrollMessage, printMessage } from './protocol';
import { matchShortcut, SHORTCUTS } from '../shell/shortcuts';

describe('print message', () => {
  it('accepts exactly a type and a plain-text note', () => {
    expect(parsePrintMessage({ type: PREVIEW_PRINT, note: 'Unofficial copy' })).toEqual({ type: PREVIEW_PRINT, note: 'Unofficial copy' });
    expect(parsePrintMessage({ type: PREVIEW_PRINT, note: '' })).toEqual({ type: PREVIEW_PRINT, note: '' });
  });

  it('drops anything else', () => {
    expect(parsePrintMessage({ type: PREVIEW_PRINT })).toBeUndefined();
    expect(parsePrintMessage({ type: PREVIEW_PRINT, note: 'x', html: '<b>' })).toBeUndefined();
    expect(parsePrintMessage({ type: 'galley-preview:render', note: 'x' })).toBeUndefined();
    expect(parsePrintMessage({ type: PREVIEW_PRINT, note: 3 })).toBeUndefined();
    expect(parsePrintMessage({ type: PREVIEW_PRINT, note: 'x'.repeat(MAX_PRINT_NOTE + 1) })).toBeUndefined();
    expect(parsePrintMessage(null)).toBeUndefined();
    expect(parsePrintMessage([PREVIEW_PRINT])).toBeUndefined();
  });

  it('builds a message that the frame accepts, cutting a long note', () => {
    const m = printMessage('n'.repeat(MAX_PRINT_NOTE + 50));
    expect(parsePrintMessage(m)?.note).toHaveLength(MAX_PRINT_NOTE);
  });

  it('is not mistaken for another preview message', () => {
    const m = printMessage('note');
    expect(parseRenderMessage(m)).toBeUndefined();
    expect(parseScrollMessage(m)).toBeUndefined();
  });
});

describe('editing shortcuts', () => {
  const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });

  it('maps Ctrl/Cmd+Shift+S to symbols and Ctrl/Cmd+Shift+F to find in files, also while typing', () => {
    expect(matchShortcut(key('S', { ctrlKey: true, shiftKey: true }), true)).toBe('symbols');
    expect(matchShortcut(key('s', { metaKey: true, shiftKey: true }), false)).toBe('symbols');
    expect(matchShortcut(key('F', { ctrlKey: true, shiftKey: true }), true)).toBe('findAll');
    expect(matchShortcut(key('F', { ctrlKey: true, shiftKey: true, altKey: true }), true)).toBeUndefined();
    // Plain Ctrl/Cmd+S stays Save for review.
    expect(matchShortcut(key('s', { ctrlKey: true }), true)).toBe('save');
  });

  it('lists both in the shortcuts dialog', () => {
    expect(SHORTCUTS.find((s) => s.action === 'symbols')?.keys).toEqual(['Ctrl', 'Shift', 'S']);
    expect(SHORTCUTS.find((s) => s.action === 'findAll')?.keys).toEqual(['Ctrl', 'Shift', 'F']);
  });
});
