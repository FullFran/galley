import { Facet, type EditorState } from '@codemirror/state';

// Vim ex commands that mean "save": in galley, saving is "Save for review"
// (a note, then a commit), the same as Ctrl/Cmd+S. Vim's own `:write` calls a
// CodeMirror 5 save command that does not exist here, so it did nothing.
// `:wq` and `:x` also quit in Vim; there is nothing to quit, so they save too.

export const SAVE_EX_COMMANDS = [
  { name: 'write', prefix: 'w' },
  { name: 'wq', prefix: 'wq' },
  { name: 'xit', prefix: 'x' },
] as const;

/** What the editor does on `:w`; the Editor component provides it. */
export const vimSave = Facet.define<() => void>();

/** Runs the editor's save request; false when it has none. */
export function requestSave(state: EditorState): boolean {
  const handlers = state.facet(vimSave);
  for (const save of handlers) save();
  return handlers.length > 0;
}

interface VimApi {
  defineEx(name: string, prefix: string, fn: (cm: { cm6: { state: EditorState } }) => void): void;
}

/** Registers the save commands on the (global) Vim instance. */
export function defineSaveCommands(vim: VimApi): void {
  for (const { name, prefix } of SAVE_EX_COMMANDS) vim.defineEx(name, prefix, (cm) => void requestSave(cm.cm6.state));
}
