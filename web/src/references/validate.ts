import { valueProblem, type EntryDraft } from './bibFile';
import { duplicateKey } from './duplicates';
import type { LibraryEntry } from './library';

// What stops a reference from being written: a key BibTeX cannot read or one
// another reference uses (biber compares keys without case), a field name
// that is not one, a field listed twice, or braces that do not match.

export type DraftProblem =
  | { kind: 'key-empty' }
  | { kind: 'key-invalid' }
  | { kind: 'key-taken'; key: string }
  | { kind: 'field-name'; index: number; name: string }
  | { kind: 'field-twice'; index: number; name: string }
  | { kind: 'unbalanced'; index: number; name: string };

const KEY = /^[^\s,{}()"=#%~\\']+$/;
const FIELD = /^[A-Za-z][\w:.+-]*$/;

/** `except`: the key of the entry being edited, which may keep its own key. */
export function validateDraft(draft: EntryDraft, library: readonly LibraryEntry[], except?: string): DraftProblem[] {
  const problems: DraftProblem[] = [];
  const key = draft.key.trim();
  if (!key) problems.push({ kind: 'key-empty' });
  else if (!KEY.test(key)) problems.push({ kind: 'key-invalid' });
  else if (duplicateKey(library, key, except)) problems.push({ kind: 'key-taken', key });
  const seen = new Set<string>();
  draft.fields.forEach((f, index) => {
    const name = f.name.trim();
    if (!FIELD.test(name)) problems.push({ kind: 'field-name', index, name });
    else if (seen.has(name.toLowerCase())) problems.push({ kind: 'field-twice', index, name });
    seen.add(name.toLowerCase());
    if (valueProblem(f.value)) problems.push({ kind: 'unbalanced', index, name });
  });
  return problems;
}
