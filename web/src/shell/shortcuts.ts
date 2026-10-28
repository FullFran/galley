// The keyboard shortcuts of galley, declared once: the handlers and the
// Keyboard shortcuts dialog both read this.

import type { Messages } from '../i18n';

export type ShortcutAction = 'toggleSidebar' | 'recompile' | 'save' | 'help';

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export const SHORTCUTS: readonly { action: ShortcutAction; keys: string[] }[] = [
  { action: 'toggleSidebar', keys: ['Ctrl', 'B'] },
  { action: 'recompile', keys: ['Ctrl', 'Enter'] },
  { action: 'save', keys: ['Ctrl', 'S'] },
  { action: 'help', keys: ['?'] },
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
  if (e.key === '?' && !mod && !e.altKey) return typing ? undefined : 'help';
  return undefined;
}

/** Text fields, where plain keys and Ctrl/Cmd+B belong to the field. */
export function typingInField(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
