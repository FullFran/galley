import { useEffect, useRef } from 'preact/hooks';
import './editing.css';
import { useT } from '../../i18n';
import { MAX_MATCHES, type FindMatch, type FindOptions, type FindResult, type ReplaceStep } from '../../editor/findAll';
import { Icon } from '../shell/icons';

// The find in files panel: query, replacement, options, results grouped by
// file with context lines. All repository text is shown as plain text
// (JSX text nodes), never as markup.

export interface FindState {
  options: FindOptions;
  replacement: string;
  busy: boolean;
  result?: FindResult & { unreadable: number; error?: 'invalid' };
  /** The last replace, for its summary and Undo. */
  last?: { steps: ReplaceStep[]; replaced: number; stale: number; skipped: string[] };
  message?: string;
}

export interface FindPanelProps {
  state: FindState;
  onOptions: (options: FindOptions) => void;
  onReplacement: (text: string) => void;
  onSearch: () => void;
  onJump: (path: string, line: number) => void;
  onReplaceOne: (path: string, match: FindMatch) => void;
  onReplaceFile: (path: string) => void;
  onReplaceAll: () => void;
  onUndo: () => void;
  onClose: () => void;
}

function MatchLine({ match }: { match: FindMatch }) {
  const start = Math.min(match.column, match.lineText.length);
  const end = Math.min(start + match.text.length, match.lineText.length);
  return (
    <>
      {match.before.map((l, i) => (
        <span key={`b${i}`} class="find-context">
          {l || ' '}
        </span>
      ))}
      <span class="find-hit-line">
        {match.lineText.slice(0, start)}
        <mark>{match.lineText.slice(start, end) || match.text}</mark>
        {match.lineText.slice(end)}
      </span>
      {match.after.map((l, i) => (
        <span key={`a${i}`} class="find-context">
          {l || ' '}
        </span>
      ))}
    </>
  );
}

export function FindPanel({ state, onOptions, onReplacement, onSearch, onJump, onReplaceOne, onReplaceFile, onReplaceAll, onUndo, onClose }: FindPanelProps) {
  const t = useT();
  const m = t.find;
  const query = useRef<HTMLInputElement>(null);
  const { options, result, busy, last } = state;
  useEffect(() => {
    query.current?.focus();
    query.current?.select();
  }, []);
  // Escape closes the panel wherever the focus is (a disabled button drops it
  // to the page while a search runs), unless a dialog is open above it.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const toggle = (key: 'caseSensitive' | 'wholeWord' | 'regex') => (e: Event) => {
    const next = { ...options, [key]: (e.currentTarget as HTMLInputElement).checked };
    onOptions(next);
  };
  const submit = (e: Event) => {
    e.preventDefault();
    onSearch();
  };
  return (
    <section
      class="find-panel"
      role="search"
      aria-labelledby="find-title"
    >
      <header class="find-head">
        <h2 id="find-title">{m.title}</h2>
        <button type="button" class="icon-button" aria-label={m.close} title={m.close} onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <form class="find-form" onSubmit={submit}>
        <label class="find-field">
          <span>{m.query}</span>
          <input ref={query} type="search" value={options.query} onInput={(e) => onOptions({ ...options, query: e.currentTarget.value })} spellcheck={false} />
        </label>
        <label class="find-field">
          <span>{m.replace}</span>
          <input type="text" value={state.replacement} onInput={(e) => onReplacement(e.currentTarget.value)} spellcheck={false} />
        </label>
        <div class="find-options">
          <label>
            <input type="checkbox" checked={options.caseSensitive} onChange={toggle('caseSensitive')} /> {m.matchCase}
          </label>
          <label>
            <input type="checkbox" checked={options.wholeWord} onChange={toggle('wholeWord')} /> {m.wholeWord}
          </label>
          <label>
            <input type="checkbox" checked={options.regex} onChange={toggle('regex')} /> {m.regex}
          </label>
        </div>
        <div class="actions">
          <button type="submit" class="primary" disabled={busy || !options.query}>
            {busy ? m.searching : m.search}
          </button>
          <button type="button" disabled={busy || !result?.total} onClick={onReplaceAll}>
            {m.replaceAll}
          </button>
        </div>
      </form>
      <div class="find-status" aria-live="polite">
        {last && (last.replaced > 0 || last.stale > 0 || last.skipped.length > 0) && (
          <div class="find-summary">
            {last.replaced > 0 && <p>{m.replaced(last.replaced, last.steps.length)}</p>}
            {last.stale > 0 && <p>{m.stale(last.stale)}</p>}
            {last.skipped.map((p) => (
              <p key={p}>{m.merging(p)}</p>
            ))}
            {last.steps.length > 0 && (
              <button type="button" onClick={onUndo}>
                {m.undo}
              </button>
            )}
          </div>
        )}
        {state.message && <p>{state.message}</p>}
        {result?.error === 'invalid' && <p class="find-error">{m.invalid}</p>}
        {result?.timedOut && <p class="find-error">{m.timedOut}</p>}
        {result && !result.error && !result.timedOut && <p class="muted">{result.total ? m.results(result.total, result.files.length) : m.none}</p>}
        {result?.truncated && <p class="muted">{m.truncated(MAX_MATCHES)}</p>}
        {result && result.unreadable > 0 && <p class="muted">{m.unreadable(result.unreadable)}</p>}
      </div>
      {result && result.files.length > 0 && (
        <ul class="find-results">
          {result.files.map((f) => (
            <li key={f.path} class="find-file">
              <div class="find-file-head">
                <span class="find-path">{f.path}</span>
                <span class="chip">{f.matches.length}</span>
                <button type="button" class="find-mini" disabled={busy} onClick={() => onReplaceFile(f.path)}>
                  {m.replaceFile}
                </button>
              </div>
              <ul>
                {f.matches.map((match) => (
                  <li key={`${match.from}`} class="find-match">
                    <button type="button" class="find-jump" onClick={() => onJump(f.path, match.line)} aria-label={`${f.path}, ${m.line(match.line)}`}>
                      <span class="find-line-no">{match.line}</span>
                      <span class="find-snippet">
                        <MatchLine match={match} />
                      </span>
                    </button>
                    <button type="button" class="find-mini find-replace-one" disabled={busy} onClick={() => onReplaceOne(f.path, match)}>
                      {m.replaceOne}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
