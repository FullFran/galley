import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { defineSaveCommands, requestSave, SAVE_EX_COMMANDS, vimSave } from './vimCommands';

type ExFn = (cm: { cm6: { state: EditorState } }) => void;

function fakeVim() {
  const defined = new Map<string, { name: string; fn: ExFn }>();
  return {
    defined,
    defineEx(name: string, prefix: string, fn: ExFn) {
      if (!name.startsWith(prefix)) throw new Error(`${prefix} is not a prefix of ${name}`);
      defined.set(prefix, { name, fn });
    },
  };
}

describe('Vim save commands', () => {
  it('maps :w, :wq and :x to Save for review', () => {
    expect(SAVE_EX_COMMANDS.map((c) => c.prefix)).toEqual(['w', 'wq', 'x']);
    const vim = fakeVim();
    defineSaveCommands(vim);
    expect([...vim.defined.keys()]).toEqual(['w', 'wq', 'x']);
    expect(vim.defined.get('w')?.name).toBe('write');
  });

  it('runs the save request of the editor the command was typed in', () => {
    const vim = fakeVim();
    defineSaveCommands(vim);
    let saves = 0;
    const state = EditorState.create({ extensions: vimSave.of(() => saves++) });
    for (const prefix of ['w', 'wq', 'x']) vim.defined.get(prefix)?.fn({ cm6: { state } });
    expect(saves).toBe(3);
  });

  it('does nothing in an editor without a save request', () => {
    expect(requestSave(EditorState.create())).toBe(false);
    expect(requestSave(EditorState.create({ extensions: vimSave.of(() => undefined) }))).toBe(true);
  });
});
