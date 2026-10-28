import { useMemo, useState } from 'preact/hooks';
import { useT } from '../i18n';
import { appendEntry, draftOf, removeEntry, updateEntry, type EntryDraft } from '../references/bibFile';
import type { Citation } from '../references/citations';
import { duplicates } from '../references/duplicates';
import { detectKeyRule, keyExample, makeKey, uniqueKey } from '../references/keys';
import { draftFacts, readLibrary, searchEntries, sortEntries, type LibraryEntry, type SortBy } from '../references/library';
import { Modal } from '../ui/shell/Modal';
import { Skeleton } from '../ui/shell/Skeleton';
import { AddReference } from '../ui/references/AddReference';
import { EntryForm } from '../ui/references/EntryForm';

// The references manager: the paper's .bib files as a searchable list and a
// form per entry. It never writes to GitHub itself: every change replaces
// the text of a .bib buffer, so it is an ordinary pending edit, saved for
// review with the rest. Entries that are not touched keep every byte.

export interface ReferencesProps {
  /** The .bib files in the person's file list. */
  paths: string[];
  /** Their current text (open buffers); undefined while loading. */
  texts: Record<string, string | undefined>;
  failed?: boolean;
  selectedKey?: string;
  /** Where keys are cited (project index); undefined until it is built. */
  cites?: Citation[];
  mailto?: string;
  label: (path: string) => string;
  onSelect: (key?: string) => void;
  onChange: (path: string, text: string) => void;
  onOpenAt: (path: string, line: number) => void;
  onNotice: (text: string) => void;
  fetchImpl?: typeof fetch;
}

const SORTS: SortBy[] = ['key', 'author', 'year', 'title'];

export function References({ paths, texts, failed, selectedKey, cites, mailto, label, onSelect, onChange, onOpenAt, onNotice, fetchImpl }: ReferencesProps) {
  const t = useT();
  const m = t.references;
  const textKey = paths.map((p) => `${p}\u0000${texts[p] ?? '\u0001'}`).join('\u0000');
  const files = useMemo(() => paths.flatMap((path) => (texts[path] === undefined ? [] : [{ path, text: texts[path] as string }])), [textKey]);
  const library = useMemo(() => readLibrary(files), [files]);
  const dups = useMemo(() => duplicates(library), [library]);
  const rule = useMemo(() => detectKeyRule(library.map((e) => ({ key: e.key, family: e.family, year: e.year, title: e.title }))), [library]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortBy>('key');
  const [file, setFile] = useState('');
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<LibraryEntry>();

  const loading = paths.some((p) => texts[p] === undefined) && !failed;
  const selected = selectedKey ? (library.find((e) => e.key === selectedKey) ?? library.find((e) => e.key.toLowerCase() === selectedKey.toLowerCase())) : undefined;
  const shown = sortEntries(searchEntries(file ? library.filter((e) => e.path === file) : library, query), sort);
  const taken = new Set(library.map((e) => e.key));
  const suggestKey = (draft: EntryDraft) => uniqueKey(makeKey(rule, draftFacts(draft)), taken);
  const keyHint = m.keyHint(keyExample(rule));
  const citesOf = (key: string) => cites?.filter((c) => c.key === key);

  const textOf = (path: string) => texts[path];
  const apply = (entry: LibraryEntry, draft: EntryDraft) => {
    const text = textOf(entry.path);
    if (text === undefined) return;
    const next = updateEntry(text, entry.entry, draft);
    if (next !== text) onChange(entry.path, next);
    onNotice(m.applied(draft.key));
    if (draft.key !== entry.key) onSelect(draft.key);
  };
  const add = (path: string, draft: EntryDraft) => {
    const text = textOf(path);
    if (text === undefined) return;
    onChange(path, appendEntry(text, draft));
    setAdding(false);
    onNotice(m.added(draft.key));
    onSelect(draft.key);
  };
  const remove = (entry: LibraryEntry) => {
    const text = textOf(entry.path);
    setDeleting(undefined);
    if (text === undefined) return;
    onChange(entry.path, removeEntry(text, entry.entry));
    onNotice(m.deleted(entry.key));
    onSelect(undefined);
  };

  if (paths.length === 0) {
    return (
      <div class="page refs-page">
        <h1>{m.title}</h1>
        <p class="notice">{m.none}</p>
      </div>
    );
  }

  const summary = paths.length === 1 ? m.summary(library.length, label(paths[0] ?? '')) : m.summaryFiles(library.length, paths.length);
  const detailOpen = adding || selected !== undefined;
  const selectedCites = selected ? citesOf(selected.key) : undefined;
  const deletingCites = deleting ? (citesOf(deleting.key) ?? []) : [];

  const badges = (e: LibraryEntry) => {
    const sameKey = dups.keys.get(e.key.toLowerCase());
    const sameDoi = e.doi ? [...dups.dois.values()].find((list) => list.includes(e)) : undefined;
    return (
      <>
        {sameKey && (
          <span class="chip chip-warn refs-chip" title={m.duplicateKeyHint(e.key)}>
            {m.duplicateKey}
          </span>
        )}
        {sameDoi && (
          <span
            class="chip chip-warn refs-chip"
            title={m.duplicateDoiHint(
              sameDoi
                .filter((o) => o !== e)
                .map((o) => o.key)
                .join(', '),
            )}
          >
            {m.duplicateDoi}
          </span>
        )}
      </>
    );
  };

  return (
    <div class="refs" data-detail={detailOpen ? 'open' : undefined}>
      <div class="refs-list-pane">
        <div class="refs-head">
          <div>
            <h1>{m.title}</h1>
            <p class="muted refs-summary">
              {summary}. {m.convention(keyExample(rule))}
            </p>
          </div>
          <button
            type="button"
            class="primary"
            disabled={loading || files.length === 0}
            onClick={() => {
              setAdding(true);
              onSelect(undefined);
            }}
          >
            {m.add}
          </button>
        </div>
        <div class="refs-tools">
          <input type="search" aria-label={m.search} placeholder={m.searchPlaceholder} value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
          <label class="refs-sort">
            <span>{m.sortBy}</span>
            <select value={sort} onChange={(e) => setSort(e.currentTarget.value as SortBy)}>
              {SORTS.map((s) => (
                <option key={s} value={s}>
                  {s === 'key' ? m.sortKey : s === 'author' ? m.sortAuthor : s === 'year' ? m.sortYear : m.sortTitle}
                </option>
              ))}
            </select>
          </label>
          {paths.length > 1 && (
            <label class="refs-sort">
              <span>{m.file}</span>
              <select value={file} onChange={(e) => setFile(e.currentTarget.value)}>
                <option value="">{m.allFiles}</option>
                {paths.map((p) => (
                  <option key={p} value={p}>
                    {label(p)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {loading ? (
          <Skeleton lines={6} label={m.loading} />
        ) : failed && files.length === 0 ? (
          <p class="notice notice-danger">{m.loadFailed}</p>
        ) : library.length === 0 ? (
          <p class="muted refs-empty">{m.empty}</p>
        ) : shown.length === 0 ? (
          <p class="muted refs-empty">{m.noMatch}</p>
        ) : (
          <ul class="refs-list" aria-label={m.title}>
            {shown.map((e) => (
              <li key={`${e.path}#${e.entry.start}`}>
                <button type="button" class="refs-row" aria-current={e === selected ? 'true' : undefined} onClick={() => {
                    setAdding(false);
                    onSelect(e.key);
                  }}>
                  <span class="refs-row-top">
                    <span class="refs-key">{e.key}</span>
                    <span class="refs-type">{e.type}</span>
                    {e.year && <span class="refs-year">{e.year}</span>}
                    {badges(e)}
                  </span>
                  <span class="refs-authors">{e.authors || m.noAuthors}</span>
                  <span class="refs-title">{e.title || m.noTitle}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div class="refs-detail">
        {adding ? (
          <AddReference
            library={library}
            paths={files.map((f) => f.path)}
            label={label}
            suggestKey={suggestKey}
            keyHint={keyHint}
            mailto={mailto}
            fetchImpl={fetchImpl}
            onAdd={add}
            onOpen={(key) => {
              setAdding(false);
              onSelect(key);
            }}
            onClose={() => setAdding(false)}
          />
        ) : selected ? (
          <section aria-labelledby="refs-entry-title">
            <div class="refs-detail-head">
              <button type="button" class="link refs-back" onClick={() => onSelect(undefined)}>
                ← {m.back}
              </button>
            </div>
            <h2 id="refs-entry-title" class="refs-entry-title">
              {selected.title || selected.key}
            </h2>
            <p class="muted refs-note">
              {selected.authors || m.noAuthors}
              {selected.year ? ` · ${selected.year}` : ''}
              {paths.length > 1 ? ` · ${label(selected.path)}` : ''}
            </p>
            <p class="refs-cited muted">
              {selectedCites === undefined ? m.citesUnknown : selectedCites.length ? m.citedIn(selectedCites.length) : m.notCited}
            </p>
            {selectedCites && selectedCites.length > 0 && <CitationList cites={selectedCites} onOpenAt={onOpenAt} />}
            <EntryForm
              key={`${selected.path}#${selected.entry.start}#${files.find((f) => f.path === selected.path)?.text.length}`}
              idPrefix="refs-edit"
              initial={draftOf(selected.entry)}
              library={library}
              except={selected.key}
              citedCount={selectedCites?.length}
              submitLabel={m.apply}
              editing
              onDiscard={() => undefined}
              onSubmit={(draft) => apply(selected, draft)}
              footer={
                <button type="button" class="refs-danger" onClick={() => setDeleting(selected)}>
                  {m.delete}
                </button>
              }
            />
          </section>
        ) : (
          <p class="muted refs-pick">{m.pick}</p>
        )}
      </div>
      <Modal open={deleting !== undefined} onClose={() => setDeleting(undefined)} labelledBy="refs-delete-title" class="refs-delete-dialog">
        <h2 id="refs-delete-title">{deleting ? m.deleteTitle(deleting.key) : ''}</h2>
        {deleting && (
          <>
            <p>{deletingCites.length ? m.deleteCited(deleting.key, deletingCites.length) : m.deleteUncited(deleting.key)}</p>
            {deletingCites.length > 0 && (
              <CitationList
                cites={deletingCites}
                onOpenAt={(path, line) => {
                  setDeleting(undefined);
                  onOpenAt(path, line);
                }}
              />
            )}
          </>
        )}
        <div class="actions">
          <button type="button" onClick={() => setDeleting(undefined)}>
            {m.cancel}
          </button>
          <button type="button" class="refs-danger" onClick={() => deleting && remove(deleting)}>
            {m.deleteConfirm}
          </button>
        </div>
      </Modal>
    </div>
  );
}

function CitationList({ cites, onOpenAt }: { cites: Citation[]; onOpenAt: (path: string, line: number) => void }) {
  const m = useT().references;
  return (
    <ul class="refs-citations">
      {cites.slice(0, 50).map((c) => (
        <li key={`${c.path}:${c.line}`}>
          <button type="button" class="refs-citation" aria-label={m.openAt(c.path, c.line)} onClick={() => onOpenAt(c.path, c.line)}>
            <span class="refs-citation-where">{m.atLine(c.path, c.line)}</span>
            <span class="refs-citation-text">{c.text}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
