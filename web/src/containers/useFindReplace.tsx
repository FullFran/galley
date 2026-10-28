import { useEffect, useRef, useState } from 'preact/hooks';
import type { RepoGateway, Repository, WorkingState } from '../domain';
import { useT } from '../i18n';
import { matchShortcut, typingAt } from '../shell/shortcuts';
import type { Buffers } from '../workspace/model';

// Find and replace across files (Ctrl/Cmd+Shift+F and the ⋯ menu). Searches
// every editable text file in view: the open buffers as they are now, the
// repository text otherwise. Replacements become unsaved buffer edits, never
// commits, and the last replace can be undone. The engine, the worker and the
// panel are their own chunk (ui/editing/FindReplace.tsx), loaded on first use.

type FindModule = typeof import('../ui/editing/FindReplace');
let chunk: Promise<FindModule> | undefined;
const loadFind = () => {
  chunk ??= import('../ui/editing/FindReplace');
  chunk.catch(() => (chunk = undefined));
  return chunk;
};

export interface FindReplaceOptions {
  enabled: boolean;
  gateway: RepoGateway;
  repo: Repository;
  working?: WorkingState;
  visible: readonly string[];
  buffers: () => Buffers;
  setBuffers: (update: (b: Buffers) => Buffers) => void;
  /** Files whose text was replaced outside the editor (the open one remounts). */
  onReplaced: (paths: string[]) => void;
  onOpenAt: (path: string, line: number) => void;
  notify: (text: string) => void;
}

export function useFindReplace(o: FindReplaceOptions) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [mod, setMod] = useState<FindModule>();
  const live = useRef(o);
  live.current = o;

  const show = () =>
    loadFind().then(
      (loaded) => {
        setMod(() => loaded);
        setOpen(true);
      },
      () => live.current.notify(t.find.failed),
    );
  const showRef = useRef(show);
  showRef.current = show;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!live.current.enabled || matchShortcut(e, typingAt(e)) !== 'findAll') return;
      e.preventDefault();
      e.stopPropagation();
      void showRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const menuItem = o.enabled ? { label: t.find.open, kbd: 'Ctrl+Shift+F', onSelect: () => void show() } : undefined;
  const panel = mod ? <mod.FindReplace {...o} open={open && o.enabled} onClose={() => setOpen(false)} /> : undefined;
  return { menuItem, panel };
}
