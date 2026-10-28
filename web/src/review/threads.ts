import type { DiffSide, ReviewComment } from '../domain';
import { anchorsOf, type DiffLine } from './diff';

export interface Thread {
  root: ReviewComment;
  replies: ReviewComment[];
  /** Diff position of the thread; undefined when the comment is outdated. */
  key?: string;
}

export const anchorKey = (path: string, side: DiffSide, line: number) => `${side}:${line}:${path}`;

const byTime = (a: ReviewComment, b: ReviewComment) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id;

/**
 * Groups review comments into conversations: GitHub replies always point at the
 * first comment of a thread. A reply whose first comment is gone stands alone.
 */
export function groupThreads(comments: readonly ReviewComment[]): Thread[] {
  const ids = new Set(comments.map((c) => c.id));
  const threads = new Map<number, Thread>();
  const sorted = [...comments].sort(byTime);
  for (const c of sorted) {
    if (c.inReplyToId === undefined || !ids.has(c.inReplyToId)) {
      threads.set(c.id, {
        root: c,
        replies: [],
        key: c.line === null ? undefined : anchorKey(c.path, c.side, c.line),
      });
    }
  }
  for (const c of sorted) {
    if (c.inReplyToId !== undefined && !threads.has(c.id)) threads.get(c.inReplyToId)?.replies.push(c);
  }
  return [...threads.values()];
}

export interface PlacedThreads {
  /** Threads shown under the diff line at this index. */
  byLine: Map<number, Thread[]>;
  /** Comments on the whole file. */
  file: Thread[];
  /** Outdated threads and threads on lines this diff does not show. */
  earlier: Thread[];
}

/** Puts each thread of one file under its diff line; nothing is dropped. */
export function placeThreads(lines: readonly DiffLine[], path: string, threads: readonly Thread[]): PlacedThreads {
  const index = new Map<string, number>();
  lines.forEach((line, i) => {
    for (const a of anchorsOf(line)) index.set(anchorKey(path, a.side, a.line), i);
  });
  const placed: PlacedThreads = { byLine: new Map(), file: [], earlier: [] };
  for (const t of threads) {
    const i = t.key === undefined ? undefined : index.get(t.key);
    if (i !== undefined) placed.byLine.set(i, [...(placed.byLine.get(i) ?? []), t]);
    else if (t.root.subjectType === 'file') placed.file.push(t);
    else placed.earlier.push(t);
  }
  return placed;
}
