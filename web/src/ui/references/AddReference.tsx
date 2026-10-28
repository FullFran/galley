import { useRef, useState } from 'preact/hooks';
import { useT } from '../../i18n';
import type { EntryDraft } from '../../references/bibFile';
import { CrossrefError, fetchDoi, type CrossrefReason } from '../../references/crossref';
import { duplicateDoi } from '../../references/duplicates';
import type { LibraryEntry } from '../../references/library';
import { EntryForm } from './EntryForm';

export interface AddReferenceProps {
  library: readonly LibraryEntry[];
  paths: string[];
  label: (path: string) => string;
  /** A key for these fields in the paper's convention, not yet taken. */
  suggestKey: (draft: EntryDraft) => string;
  keyHint: string;
  mailto?: string;
  fetchImpl?: typeof fetch;
  onAdd: (path: string, draft: EntryDraft) => void;
  onOpen: (key: string) => void;
  onClose: () => void;
}

type Lookup = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; reason: CrossrefReason } | { kind: 'found'; draft: EntryDraft; seq: number } | { kind: 'exists'; key: string };

const TEMPLATE: EntryDraft = {
  type: 'article',
  key: '',
  fields: ['author', 'title', 'journal', 'year', 'volume', 'number', 'pages', 'doi'].map((name) => ({ name, value: '' })),
};

/** Add a reference from a DOI (Crossref) or with a form; it goes into a .bib buffer like any edit. */
export function AddReference({ library, paths, label, suggestKey, keyHint, mailto, fetchImpl, onAdd, onOpen, onClose }: AddReferenceProps) {
  const t = useT();
  const m = t.references;
  const [tab, setTab] = useState<'doi' | 'form'>('doi');
  const [doi, setDoi] = useState('');
  const [lookup, setLookup] = useState<Lookup>({ kind: 'idle' });
  const [path, setPath] = useState(paths[0] ?? '');
  const seq = useRef(0);

  const look = async (e: Event) => {
    e.preventDefault();
    const mine = ++seq.current;
    setLookup({ kind: 'loading' });
    try {
      const draft = await fetchDoi(doi, { fetch: fetchImpl, mailto });
      if (mine !== seq.current) return;
      const found = draft.fields.find((f) => f.name === 'doi')?.value ?? doi;
      const existing = duplicateDoi(library, found) ?? duplicateDoi(library, doi);
      if (existing) return setLookup({ kind: 'exists', key: existing.key });
      setLookup({ kind: 'found', draft: { ...draft, key: suggestKey(draft) }, seq: mine });
    } catch (err) {
      if (mine !== seq.current) return;
      setLookup({ kind: 'error', reason: err instanceof CrossrefError ? err.reason : 'network' });
    }
  };

  const errorText = (reason: CrossrefReason) =>
    reason === 'invalid-doi' ? m.doiInvalid : reason === 'not-found' ? m.doiNotFound : reason === 'network' ? m.doiNetwork : m.doiJunk;

  const target =
    paths.length > 1 ? (
      <label class="refs-target">
        <span>{m.addTo}</span>
        <select value={path} onChange={(e) => setPath(e.currentTarget.value)}>
          {paths.map((p) => (
            <option key={p} value={p} title={p}>
              {label(p)}
            </option>
          ))}
        </select>
      </label>
    ) : null;

  return (
    <section class="refs-add" aria-labelledby="refs-add-title">
      <div class="refs-detail-head">
        <h2 id="refs-add-title">{m.addTitle}</h2>
        <button type="button" class="icon-button" aria-label={m.close} title={m.close} onClick={onClose}>
          ×
        </button>
      </div>
      <div class="segmented refs-tabs" role="radiogroup" aria-label={m.addTitle}>
        <button type="button" role="radio" aria-checked={tab === 'doi'} onClick={() => setTab('doi')}>
          {m.fromDoi}
        </button>
        <button type="button" role="radio" aria-checked={tab === 'form'} onClick={() => setTab('form')}>
          {m.fromForm}
        </button>
      </div>
      {tab === 'doi' ? (
        <>
          <form class="refs-doi" onSubmit={look}>
            <label for="refs-doi-input">{m.doi}</label>
            <div class="refs-doi-row">
              <input
                id="refs-doi-input"
                value={doi}
                placeholder={m.doiPlaceholder}
                spellcheck={false}
                autocomplete="off"
                inputMode="url"
                onInput={(e) => setDoi(e.currentTarget.value)}
              />
              <button type="submit" class="primary" disabled={!doi.trim() || lookup.kind === 'loading'}>
                {m.lookUp}
              </button>
            </div>
            <p class="muted refs-note">{m.crossrefNote}</p>
          </form>
          <div aria-live="polite">
            {lookup.kind === 'loading' && <p class="muted">{m.lookingUp}</p>}
            {lookup.kind === 'error' && (
              <p class="refs-problem" role="alert">
                {errorText(lookup.reason)}
              </p>
            )}
            {lookup.kind === 'exists' && (
              <div class="notice notice-warn refs-exists" role="status">
                <p>{m.doiExists(lookup.key)}</p>
                <button type="button" onClick={() => onOpen(lookup.key)}>
                  {m.openExisting}
                </button>
              </div>
            )}
          </div>
          {lookup.kind === 'found' && (
            <>
              <h3 class="refs-found">{m.found}</h3>
              <EntryForm
                key={lookup.seq}
                idPrefix="refs-new-doi"
                initial={lookup.draft}
                library={library}
                keyHint={keyHint}
                submitLabel={m.addEntry}
                onSubmit={(draft) => onAdd(path, draft)}
                footer={target}
              />
            </>
          )}
        </>
      ) : (
        <EntryForm
          idPrefix="refs-new-form"
          initial={{ ...TEMPLATE, key: suggestKey(TEMPLATE) }}
          library={library}
          suggestKey={suggestKey}
          keyHint={keyHint}
          submitLabel={m.addEntry}
          onSubmit={(draft) => onAdd(path, { ...draft, fields: draft.fields.filter((f) => f.value.trim() !== '') })}
          footer={target}
        />
      )}
    </section>
  );
}
