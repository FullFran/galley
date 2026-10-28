import type { DiffSide } from '../domain';

export type DiffLine =
  | { kind: 'hunk'; text: string }
  | { kind: 'meta'; text: string }
  | { kind: 'context'; text: string; oldLine: number; newLine: number }
  | { kind: 'del'; text: string; oldLine: number }
  | { kind: 'add'; text: string; newLine: number };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Splits a unified diff (GitHub's `patch` field) into numbered lines. */
export function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split('\n')) {
    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      lines.push({ kind: 'hunk', text: raw });
    } else if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text: raw.slice(1), newLine: newLine++ });
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', text: raw.slice(1), oldLine: oldLine++ });
    } else if (raw.startsWith(' ') || (raw === '' && lines.length > 0)) {
      lines.push({ kind: 'context', text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
    } else {
      lines.push({ kind: 'meta', text: raw });
    }
  }
  // A trailing newline in the patch is not an extra context line.
  const last = lines[lines.length - 1];
  if (last?.kind === 'context' && last.text === '' && patch.endsWith('\n')) lines.pop();
  return lines;
}

/**
 * Every position a comment on this line can have: an unchanged line exists on
 * both sides, so it carries both its new (RIGHT) and old (LEFT) line number.
 */
export function anchorsOf(line: DiffLine): { side: DiffSide; line: number }[] {
  if (line.kind === 'context') {
    return [
      { side: 'RIGHT', line: line.newLine },
      { side: 'LEFT', line: line.oldLine },
    ];
  }
  const anchor = anchorOf(line);
  return anchor ? [anchor] : [];
}

/** Where a new comment on this diff line is anchored, as GitHub's `side` and `line`. */
export function anchorOf(line: DiffLine): { side: DiffSide; line: number } | undefined {
  switch (line.kind) {
    case 'del':
      return { side: 'LEFT', line: line.oldLine };
    case 'add':
    case 'context':
      return { side: 'RIGHT', line: line.newLine };
    default:
      return undefined;
  }
}

/** The new-side text of lines `start`..`end`, if all of them are in the patch. */
export function rightLines(patch: string, start: number, end: number): string[] | undefined {
  const byLine = new Map<number, string>();
  for (const l of parsePatch(patch)) if (l.kind === 'add' || l.kind === 'context') byLine.set(l.newLine, l.text);
  const lines: string[] = [];
  for (let n = start; n <= end; n++) {
    const text = byLine.get(n);
    if (text === undefined) return undefined;
    lines.push(text);
  }
  return lines;
}
