import { merge3 } from '../workspace/merge3';
import type { Buffer } from '../workspace/model';
import type { DraftMeta } from './http';
import type { LocalDraft } from './store';
import type { DraftConflict } from './sync';

// Bringing a draft back into the editor. When the file changed in the
// repository since the draft's text started, the draft is merged with the
// current text the same way the default branch is brought in (line-level
// three-way merge): a clean merge becomes the buffer, a conflict opens the
// usual choice view. A draft never silently replaces repository changes.

export type Restored =
  /** The draft equals the current text: nothing to restore. */
  | { kind: 'none' }
  /** Same base: the draft over the current text. */
  | { kind: 'same'; buffer: Buffer }
  /** Another base, merged cleanly with the current text. */
  | { kind: 'merged'; buffer: Buffer }
  /** Another base and the same lines changed: the person chooses. */
  | { kind: 'conflict'; buffer: Buffer };

/**
 * `readAt` reads the file at a commit (the draft's base). An unreadable base
 * is taken as empty, so every difference becomes a choice.
 */
export async function restoreBuffer(
  draft: { content: string; baseSha: string },
  current: { text: string; headSha: string },
  readAt: (sha: string) => Promise<string>,
): Promise<Restored> {
  if (draft.content === current.text) return { kind: 'none' };
  if (draft.baseSha === current.headSha) return { kind: 'same', buffer: { base: current.text, text: draft.content } };
  const base = await readAt(draft.baseSha).catch(() => '');
  if (base === current.text) return { kind: 'same', buffer: { base: current.text, text: draft.content } };
  const result = merge3(base, draft.content, current.text);
  if (result.kind === 'clean') return { kind: 'merged', buffer: { base: current.text, text: result.text } };
  return { kind: 'conflict', buffer: { base: current.text, text: draft.content, merge: { base, regions: result.regions } } };
}

export interface RestorePlan {
  /** This browser's drafts: restored on open. */
  local: LocalDraft[];
  /** Server drafts this browser does not have (another device): offered. */
  offer: DraftMeta[];
  /** Server drafts newer than this browser's copy of the same file. */
  conflicts: DraftConflict[];
}

export function planRestore(local: LocalDraft[], server: DraftMeta[]): RestorePlan {
  const mine = new Map(local.map((d) => [d.path, d]));
  const offer: DraftMeta[] = [];
  const conflicts: DraftConflict[] = [];
  for (const m of server) {
    const d = mine.get(m.path);
    if (!d) offer.push(m);
    else if (d.server?.etag !== m.etag) conflicts.push({ path: m.path, current: m });
  }
  const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
  return { local: [...local].sort(byPath), offer: offer.sort(byPath), conflicts: conflicts.sort(byPath) };
}
