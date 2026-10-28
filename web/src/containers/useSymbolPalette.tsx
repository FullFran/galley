import { useEffect, useRef, useState } from 'preact/hooks';
import type { EditorView } from '@codemirror/view';
import { useT } from '../i18n';
import { matchShortcut, typingAt } from '../shell/shortcuts';
import type { MathSymbol } from '../editor/symbols';

// The symbol palette (Ctrl/Cmd+Shift+S, a header button and a ⋯ menu entry).
// Its UI and KaTeX, for the previews, are one chunk loaded on first use.

type PaletteModule = typeof import('../ui/editing/SymbolPalette');
let chunk: Promise<PaletteModule> | undefined;
const loadPalette = () => {
  chunk ??= import('../ui/editing/SymbolPalette');
  chunk.catch(() => (chunk = undefined));
  return chunk;
};

export interface SymbolPaletteOptions {
  /** False away from the editor (admin, history): no shortcut, no button. */
  enabled: boolean;
  /** The editor view of the open text file, if any. */
  view: () => EditorView | undefined;
  notify: (text: string) => void;
}

export function useSymbolPalette({ enabled, view, notify }: SymbolPaletteOptions) {
  const t = useT();
  const m = t.symbols;
  const [open, setOpen] = useState(false);
  const [mod, setMod] = useState<PaletteModule>();
  const live = useRef({ enabled, view, notify, m });
  live.current = { enabled, view, notify, m };

  const show = () => {
    if (!live.current.view()) return live.current.notify(live.current.m.noEditor);
    loadPalette().then(
      (loaded) => {
        setMod(() => loaded);
        setOpen(true);
      },
      () => live.current.notify(live.current.m.failed),
    );
  };
  const showRef = useRef(show);
  showRef.current = show;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!live.current.enabled || matchShortcut(e, typingAt(e)) !== 'symbols') return;
      e.preventDefault();
      e.stopPropagation();
      showRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const insert = (symbol: MathSymbol) => {
    const v = view();
    setOpen(false);
    if (!v || !mod) return notify(m.noEditor);
    mod.insertSymbol(v, symbol);
    // The dialog gives the focus back to its opener; the text comes after that.
    setTimeout(() => v.focus(), 0);
  };

  const button = enabled ? (
    <button type="button" class="icon-button symbol-button" title={m.openHint} aria-label={m.openHint} aria-keyshortcuts="Control+Shift+S Meta+Shift+S" onClick={show}>
      <span aria-hidden="true">Σ</span>
    </button>
  ) : undefined;
  const menuItem = enabled ? { label: m.open, kbd: 'Ctrl+Shift+S', onSelect: show } : undefined;
  const dialog = mod ? <mod.SymbolPalette open={open} onClose={() => setOpen(false)} onInsert={insert} /> : undefined;
  return { button, menuItem, dialog };
}
