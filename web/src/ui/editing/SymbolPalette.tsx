import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import './editing.css';
import { useT } from '../../i18n';
import type { EditorView } from '@codemirror/view';
import { planSymbolInsert, pushRecent, readRecent, searchSymbols, symbolById, type KeyStore, type MathSymbol } from '../../editor/symbols';
import { Modal } from '../shell/Modal';

// The symbol palette dialog. Its own chunk, with KaTeX: each preview is
// rendered when it scrolls into view. katex.render builds DOM nodes and sets
// styles through the CSSOM, which the app CSP (`style-src 'self'`) allows;
// the previews are fixed catalog strings, rendered with trust off.

const storage = (): KeyStore | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

/** Inserts `symbol` at the selection of `view`, in `$…$` when the cursor is not in math; remembers it as recent. */
export function insertSymbol(view: EditorView, symbol: MathSymbol) {
  const { from, to } = view.state.selection.main;
  const plan = planSymbolInsert(view.state.doc.toString(), from, to, symbol.insert);
  view.dispatch({ changes: { from: plan.from, to: plan.to, insert: plan.insert }, selection: { anchor: plan.caret }, scrollIntoView: true, userEvent: 'input' });
  pushRecent(storage(), symbol.id);
}

let observer: IntersectionObserver | undefined;
const pending = new WeakMap<Element, () => void>();

function whenVisible(el: Element, run: () => void) {
  if (typeof IntersectionObserver === 'undefined') return run();
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      pending.get(e.target)?.();
      pending.delete(e.target);
      observer?.unobserve(e.target);
    }
  });
  pending.set(el, run);
  observer.observe(el);
  return () => {
    pending.delete(el);
    observer?.unobserve(el);
  };
}

function SymbolPreview({ source }: { source: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return whenVisible(el, () => {
      try {
        katex.render(source, el, { throwOnError: false, trust: false, strict: 'ignore', output: 'html' });
      } catch {
        el.textContent = source;
      }
    });
  }, [source]);
  return <span class="symbol-preview" ref={ref} aria-hidden="true" />;
}

function SymbolCell({ symbol, onInsert, label }: { symbol: MathSymbol; onInsert: (s: MathSymbol) => void; label: string }) {
  return (
    <li>
      <button type="button" class="symbol-cell" title={label} aria-label={label} onClick={() => onInsert(symbol)}>
        <SymbolPreview source={symbol.preview} />
        <code class="symbol-command">{symbol.id}</code>
      </button>
    </li>
  );
}

export interface SymbolPaletteProps {
  open: boolean;
  onClose: () => void;
  onInsert: (symbol: MathSymbol) => void;
}

export function SymbolPalette({ open, onClose, onInsert }: SymbolPaletteProps) {
  const t = useT();
  const m = t.symbols;
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const groups = useMemo(() => searchSymbols(query), [query]);
  // Read again each time the palette opens (an insertion just changed it).
  const recent = useMemo(() => (open ? readRecent(storage()) : []), [open]);
  const recentSymbols = recent.map(symbolById).filter((s): s is MathSymbol => s !== undefined);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    input.current?.focus();
  }, [open]);

  const first = groups[0]?.symbols[0];
  return (
    <Modal open={open} onClose={onClose} labelledBy="symbols-title" class="symbol-palette">
      <h2 id="symbols-title">{m.title}</h2>
      <input
        ref={input}
        type="search"
        class="symbol-search"
        aria-label={m.search}
        placeholder={m.placeholder}
        value={query}
        onInput={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && first) {
            e.preventDefault();
            onInsert(first);
          }
        }}
      />
      <p class="muted symbol-hint">{m.hint}</p>
      <div class="symbol-groups">
        {!query && recentSymbols.length > 0 && (
          <section aria-labelledby="symbols-recent">
            <h3 id="symbols-recent">{m.recent}</h3>
            <ul class="symbol-grid">
              {recentSymbols.map((s) => (
                <SymbolCell key={`r-${s.id}`} symbol={s} onInsert={onInsert} label={m.insert(s.insert)} />
              ))}
            </ul>
          </section>
        )}
        {groups.map((g) => (
          <section key={g.id} aria-labelledby={`symbols-${g.id}`}>
            <h3 id={`symbols-${g.id}`}>{m.groups[g.id]}</h3>
            <ul class="symbol-grid">
              {g.symbols.map((s) => (
                <SymbolCell key={s.id} symbol={s} onInsert={onInsert} label={m.insert(s.insert)} />
              ))}
            </ul>
          </section>
        ))}
        {groups.length === 0 && <p class="muted">{m.none}</p>}
      </div>
      <div class="actions">
        <button type="button" onClick={onClose}>
          {m.close}
        </button>
      </div>
    </Modal>
  );
}
