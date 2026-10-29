// The keyboard shortcuts of galley, declared once: the handlers and the
// Keyboard shortcuts dialog both read this.

import type { Messages } from '../i18n';

export type ShortcutAction = 'toggleSidebar' | 'recompile' | 'save' | 'help' | 'symbols' | 'findAll' | 'togglePane';

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** The physical key (Option+V types √ on a Mac). */
  code?: string;
}

export const SHORTCUTS: readonly { action: ShortcutAction; keys: string[] }[] = [
  { action: 'toggleSidebar', keys: ['Ctrl', 'B'] },
  { action: 'recompile', keys: ['Ctrl', 'Enter'] },
  { action: 'save', keys: ['Ctrl', 'S'] },
  { action: 'help', keys: ['?'] },
  { action: 'symbols', keys: ['Ctrl', 'Shift', 'S'] },
  { action: 'findAll', keys: ['Ctrl', 'Shift', 'F'] },
  { action: 'togglePane', keys: ['Ctrl', 'Alt', 'V'] },
];

export function shortcutLabel(action: ShortcutAction, t: Messages): string {
  return t.shortcuts[action];
}

/**
 * The action for a key press. Ctrl/Cmd+B and `?` mean something else in text
 * fields (bold, a question mark), so they are left alone there; Ctrl/Cmd+Enter
 * and Ctrl/Cmd+S work everywhere, including the editor.
 */
export function matchShortcut(e: KeyLike, typing: boolean): ShortcutAction | undefined {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && !e.altKey && !e.shiftKey) {
    if (key === 'b') return typing ? undefined : 'toggleSidebar';
    if (key === 'enter') return 'recompile';
    if (key === 's') return 'save';
    return undefined;
  }
  // Ctrl/Cmd+Shift+S (symbol palette) and Ctrl/Cmd+Shift+F (find in files) work while typing too.
  if (mod && e.shiftKey && !e.altKey) {
    if (key === 's') return 'symbols';
    if (key === 'f') return 'findAll';
    return undefined;
  }
  // Ctrl/Cmd+Alt+V (text only / preview only) works while typing too.
  if (mod && e.altKey && !e.shiftKey) return key === 'v' || e.code === 'KeyV' ? 'togglePane' : undefined;
  if (e.key === '?' && !mod && !e.altKey) return typing ? undefined : 'help';
  return undefined;
}

/** Text fields, where plain keys and Ctrl/Cmd+B belong to the field. */
export function typingInField(target: EventTarget | null): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName.toUpperCase());
}

/**
 * The element a key event came from. The editor lives in a shadow root, and a
 * window listener sees its events retargeted to the shadow host (a plain
 * <div>); the real origin, the editor text or the Vim command line, is the
 * first entry of the composed path.
 */
export function keyOrigin(e: { target: EventTarget | null; composedPath?: () => EventTarget[] }): EventTarget | null {
  return e.composedPath?.()[0] ?? e.target;
}

/** Whether a key event was typed into a text field, including inside the editor. */
export function typingAt(e: { target: EventTarget | null; composedPath?: () => EventTarget[] }): boolean {
  return typingInField(keyOrigin(e));
}
