import { useMemo, useRef, useState } from 'preact/hooks';
import { useT } from '../../i18n';
import { createTextCache } from '../../editor/textCache';
import { fileKind } from '../../workspace/tree';
import { compileQuery, replaceMatches, undoable, type FileMatches, type FindMatch, type FindOptions, type ReplaceStep } from '../../editor/findAll';
import { createFindRunner } from '../../editor/findRunner';
import type { FindReplaceOptions } from '../../containers/useFindReplace';
import { FindPanel, type FindState } from './FindPanel';

// The state and actions of find in files, in the panel's chunk. It stays
// mounted once loaded, so closing and reopening keeps the query and results.

const INITIAL: FindOptions = { query: '', caseSensitive: false, wholeWord: false, regex: false };

export function FindReplace({ open, onClose, ...o }: FindReplaceOptions & { open: boolean; onClose: () => void }) {
  const t = useT();
  const m = t.find;
  const [state, setState] = useState<FindState>({ options: INITIAL, replacement: '', busy: false });
  const live = useRef(o);
  live.current = o;
  const stateRef = useRef(state);
  stateRef.current = state;
  // Texts the last search read, by path: the base of files without a buffer yet.
  const searched = useRef(new Map<string, string>());
  const run = useMemo(() => createFindRunner(), []);
  const cache = useMemo(() => createTextCache((path, ref) => live.current.gateway.readFile(live.current.repo, path, ref)), [o.gateway, o.repo]);
  const seq = useRef(0);

  /** The searchable files with their current text. */
  const texts = async () => {
    const { working, visible, buffers } = live.current;
    if (!working) return { files: [], unreadable: 0 };
    const paths = visible.filter((p) => fileKind(p) !== 'binary');
    const b = buffers();
    const fromRepo = await cache.texts(paths.filter((p) => !b[p]), working.blobs, working.headSha);
    const repoText = new Map(fromRepo.map((f) => [f.path, f.text]));
    const files: { path: string; text: string }[] = [];
    let unreadable = 0;
    searched.current = new Map();
    for (const path of paths) {
      const text = b[path]?.text ?? repoText.get(path);
      if (text === undefined) {
        unreadable++;
        continue;
      }
      if (!b[path]) searched.current.set(path, text);
      files.push({ path, text });
    }
    return { files, unreadable };
  };

  const search = async (options = stateRef.current.options) => {
    const mine = ++seq.current;
    if (!options.query) return setState((s) => ({ ...s, result: undefined, busy: false }));
    setState((s) => ({ ...s, busy: true }));
    const { files, unreadable } = await texts();
    if (!compileQuery(options).ok) {
      if (mine === seq.current) setState((s) => ({ ...s, busy: false, result: { files: [], total: 0, truncated: false, timedOut: false, unreadable, error: 'invalid' } }));
      return;
    }
    const result = await run(files, options);
    if (mine === seq.current) setState((s) => ({ ...s, busy: false, result: { ...result, unreadable } }));
  };

  /** Applies replacements to the chosen matches; each file becomes an unsaved edit. */
  const replace = (groups: readonly FileMatches[]) => {
    const { options, replacement } = stateRef.current;
    const b = live.current.buffers();
    const steps: ReplaceStep[] = [];
    const skipped: string[] = [];
    let replaced = 0;
    let stale = 0;
    const next: Record<string, { base: string; text: string }> = {};
    for (const g of groups) {
      const buffer = b[g.path];
      if (buffer?.merge) {
        skipped.push(g.path);
        continue;
      }
      const before = buffer?.text ?? searched.current.get(g.path);
      if (before === undefined) {
        stale += g.matches.length;
        continue;
      }
      const out = replaceMatches(before, g.matches, options, replacement);
      stale += out.stale;
      if (!out.replaced) continue;
      replaced += out.replaced;
      steps.push({ path: g.path, before, after: out.text });
      next[g.path] = { base: buffer?.base ?? before, text: out.text };
    }
    if (steps.length) {
      live.current.setBuffers((cur) => {
        const merged = { ...cur };
        for (const [path, value] of Object.entries(next)) merged[path] = { base: cur[path]?.base ?? value.base, text: value.text };
        return merged;
      });
      live.current.onReplaced(steps.map((s) => s.path));
    }
    setState((s) => ({ ...s, last: { steps, replaced, stale, skipped }, message: undefined }));
    // Offsets moved: search again on the new text.
    setTimeout(() => void search(), 0);
  };

  const replaceOne = (path: string, match: FindMatch) => replace([{ path, matches: [match] }]);
  const replaceFile = (path: string) => {
    const g = stateRef.current.result?.files.find((f) => f.path === path);
    if (g) replace([g]);
  };
  const replaceAll = () => {
    const r = stateRef.current.result;
    if (!r || !r.total || !window.confirm(m.confirmAll(r.total, r.files.length))) return;
    replace(r.files);
  };

  const undo = () => {
    const last = stateRef.current.last;
    if (!last) return;
    const { restore, changed } = undoable(last.steps, (p) => live.current.buffers()[p]?.text);
    if (restore.length) {
      live.current.setBuffers((cur) => {
        const merged = { ...cur };
        for (const r of restore) {
          const buffer = cur[r.path];
          if (buffer) merged[r.path] = { ...buffer, text: r.text };
        }
        return merged;
      });
      live.current.onReplaced(restore.map((r) => r.path));
    }
    const message = [m.undone(restore.length), changed.length ? m.undoChanged(changed.join(', ')) : ''].filter(Boolean).join(' ');
    setState((s) => ({ ...s, last: undefined, message }));
    setTimeout(() => void search(), 0);
  };

  if (!open) return null;
  return (
    <FindPanel
      state={state}
      onOptions={(options) => setState((s) => ({ ...s, options }))}
      onReplacement={(replacement) => setState((s) => ({ ...s, replacement }))}
      onSearch={() => void search()}
      onJump={(path, line) => live.current.onOpenAt(path, line)}
      onReplaceOne={replaceOne}
      onReplaceFile={replaceFile}
      onReplaceAll={replaceAll}
      onUndo={undo}
      onClose={onClose}
    />
  );
}
