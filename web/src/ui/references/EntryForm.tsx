import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { useT, type Messages } from '../../i18n';
import { rawExpressionOk, type DraftField, type EntryDraft } from '../../references/bibFile';
import type { LibraryEntry } from '../../references/library';
import { validateDraft, type DraftProblem } from '../../references/validate';

export const ENTRY_TYPES = [
  'article',
  'book',
  'inbook',
  'incollection',
  'inproceedings',
  'proceedings',
  'phdthesis',
  'mastersthesis',
  'techreport',
  'manual',
  'misc',
  'online',
  'dataset',
  'software',
  'unpublished',
];

const FIELD_NAMES = [
  'author',
  'editor',
  'title',
  'journal',
  'booktitle',
  'year',
  'month',
  'volume',
  'number',
  'pages',
  'publisher',
  'address',
  'edition',
  'school',
  'institution',
  'organization',
  'doi',
  'url',
  'isbn',
  'issn',
  'note',
  'urldate',
  'keywords',
  'abstract',
];

export interface EntryFormProps {
  /** Starting point; the form keeps its own copy until submitted. */
  initial: EntryDraft;
  library: readonly LibraryEntry[];
  /** The key of the entry being edited (it may keep it). */
  except?: string;
  /** Proposes a key from the fields while the key has not been typed by hand. */
  suggestKey?: (draft: EntryDraft) => string;
  keyHint?: string;
  /** How many places cite the original key; undefined while unknown. */
  citedCount?: number;
  submitLabel: string;
  onSubmit: (draft: EntryDraft) => void;
  /** Edit mode: Apply is offered only once something changed. */
  editing?: boolean;
  onDiscard?: () => void;
  /** Shown under the fields (file choice, delete button). */
  footer?: ComponentChildren;
  idPrefix: string;
}

function problemText(p: DraftProblem, m: Messages['references']): string {
  switch (p.kind) {
    case 'key-empty':
      return m.keyEmpty;
    case 'key-invalid':
      return m.keyInvalid;
    case 'key-taken':
      return m.keyTaken(p.key);
    case 'field-name':
      return m.fieldNameInvalid(p.name);
    case 'field-twice':
      return m.fieldTwice(p.name);
    case 'unbalanced':
      return m.unbalanced(p.name);
  }
}

const same = (a: EntryDraft, b: EntryDraft) =>
  a.type === b.type &&
  a.key === b.key &&
  a.fields.length === b.fields.length &&
  a.fields.every((f, i) => f.name === b.fields[i]?.name && f.value === b.fields[i]?.value && f.kind === b.fields[i]?.kind);

/** The fields of one reference as a form: type, key, and name/value rows. */
export function EntryForm({ initial, library, except, suggestKey, keyHint, citedCount, submitLabel, onSubmit, editing, onDiscard, footer, idPrefix }: EntryFormProps) {
  const t = useT();
  const m = t.references;
  const [draft, setDraft] = useState<EntryDraft>(initial);
  const [keyTyped, setKeyTyped] = useState(false);
  const problems = useMemo(() => validateDraft({ ...draft, key: draft.key.trim() }, library, except), [draft, library, except]);
  const changed = !same(draft, initial);
  const types = ENTRY_TYPES.includes(draft.type.toLowerCase()) ? ENTRY_TYPES : [draft.type, ...ENTRY_TYPES];

  const update = (next: EntryDraft) => setDraft(suggestKey && !keyTyped ? { ...next, key: suggestKey(next) } : next);
  const setField = (index: number, change: Partial<DraftField>) => {
    const fields = draft.fields.map((f, i) => {
      if (i !== index) return f;
      const next = { ...f, ...change };
      // A macro or number that is no longer one gets the entry's delimiters.
      if (change.value !== undefined && f.kind === 'raw' && !rawExpressionOk(change.value)) delete next.kind;
      return next;
    });
    update({ ...draft, fields });
  };
  const fieldProblems = (index: number) => problems.filter((p) => 'index' in p && p.index === index);
  const keyProblem = problems.find((p) => p.kind.startsWith('key-'));
  const renamed = except !== undefined && draft.key.trim() !== except && citedCount !== undefined && citedCount > 0;

  const submit = (e: Event) => {
    e.preventDefault();
    if (problems.length > 0) return;
    onSubmit({ ...draft, key: draft.key.trim(), fields: draft.fields.map((f) => ({ ...f, name: f.name.trim() })) });
  };

  return (
    <form class="refs-form" onSubmit={submit} noValidate>
      <div class="refs-form-row">
        <label for={`${idPrefix}-type`}>{m.type}</label>
        <select id={`${idPrefix}-type`} value={draft.type} onChange={(e) => update({ ...draft, type: e.currentTarget.value })}>
          {types.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </div>
      <div class="refs-form-row">
        <label for={`${idPrefix}-key`}>{m.key}</label>
        <input
          id={`${idPrefix}-key`}
          class="refs-key-input"
          value={draft.key}
          spellcheck={false}
          autocomplete="off"
          aria-invalid={keyProblem ? 'true' : undefined}
          aria-describedby={`${idPrefix}-key-note`}
          onInput={(e) => {
            setKeyTyped(true);
            setDraft({ ...draft, key: e.currentTarget.value });
          }}
        />
        <p id={`${idPrefix}-key-note`} class={keyProblem ? 'refs-problem' : 'muted refs-note'} role={keyProblem ? 'alert' : undefined}>
          {keyProblem ? problemText(keyProblem, m) : renamed ? m.renameWarning(citedCount ?? 0, except ?? '') : (keyHint ?? '')}
        </p>
      </div>
      <fieldset class="refs-fields">
        <legend>{m.fields}</legend>
        <datalist id={`${idPrefix}-names`}>
          {FIELD_NAMES.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        {draft.fields.map((field, i) => {
          const own = fieldProblems(i);
          const name = field.name || m.fieldName;
          return (
            <div class="refs-field" key={i}>
              <input
                class="refs-field-name"
                aria-label={m.fieldName}
                list={`${idPrefix}-names`}
                value={field.name}
                spellcheck={false}
                autocomplete="off"
                aria-invalid={own.some((p) => p.kind !== 'unbalanced') ? 'true' : undefined}
                onInput={(e) => setField(i, { name: e.currentTarget.value })}
              />
              <textarea
                class="refs-field-value"
                aria-label={m.fieldValue(name)}
                rows={field.value.length > 70 || field.value.includes('\n') ? 3 : 1}
                value={field.value}
                spellcheck={false}
                aria-invalid={own.some((p) => p.kind === 'unbalanced') ? 'true' : undefined}
                onInput={(e) => setField(i, { value: e.currentTarget.value })}
              />
              <button
                type="button"
                class="icon-button refs-remove"
                aria-label={m.removeField(name)}
                title={m.removeField(name)}
                onClick={() => update({ ...draft, fields: draft.fields.filter((_, j) => j !== i) })}
              >
                ×
              </button>
              {own.map((p) => (
                <p key={p.kind} class="refs-problem refs-field-problem" role="alert">
                  {problemText(p, m)}
                </p>
              ))}
            </div>
          );
        })}
        <button type="button" class="refs-add-field" onClick={() => update({ ...draft, fields: [...draft.fields, { name: '', value: '' }] })}>
          + {m.addField}
        </button>
      </fieldset>
      <div class="refs-form-actions">
        <button type="submit" class="primary" disabled={problems.length > 0 || (editing && !changed)}>
          {submitLabel}
        </button>
        {editing && changed && onDiscard && (
          <button
            type="button"
            onClick={() => {
              setDraft(initial);
              setKeyTyped(false);
              onDiscard();
            }}
          >
            {m.discard}
          </button>
        )}
        {footer}
      </div>
      <p class="muted refs-note">{m.pendingNote}</p>
    </form>
  );
}
