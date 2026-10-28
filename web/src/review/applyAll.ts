import { PermissionError, SuggestionMismatchError, type Proposal, type RepoAccess, type Repository, type ReviewComment } from '../domain';
import { coAuthorTrailer, expectedLines, parseSuggestion, replaceLines, type ApplyDeps } from './suggestion';
import { groupThreads } from './threads';
import type { Messages } from '../i18n/en';

// "Apply all suggestions": every open suggestion of a proposal in ONE commit
// on its head branch, with the same rules as a single apply (same repository,
// push permission, exact lines, fast-forward only). Suggestions whose lines
// changed, that overlap one taken earlier, or that refer to an older version
// are skipped and reported; the rest still go in.

export type SkipReason = 'changed' | 'overlap' | 'outdated';

export interface ApplyAllResult {
  /** The new head commit; undefined when nothing could be applied. */
  sha?: string;
  applied: ReviewComment[];
  skipped: { comment: ReviewComment; reason: SkipReason }[];
}

/** Comments with a suggestion in threads that are not resolved (outdated ones included, to report them). */
export function openSuggestions(comments: readonly ReviewComment[], states: Readonly<Record<number, { resolved: boolean } | undefined>>): ReviewComment[] {
  const rootOf = new Map<number, number>();
  for (const th of groupThreads(comments)) {
    rootOf.set(th.root.id, th.root.id);
    for (const r of th.replies) rootOf.set(r.id, th.root.id);
  }
  return comments.filter((c) => parseSuggestion(c.body) !== undefined && states[rootOf.get(c.id) ?? c.id]?.resolved !== true);
}

interface Planned {
  comment: ReviewComment;
  start: number;
  end: number;
  expected: string[];
  replacement: string;
}

export async function applyAllSuggestions(
  deps: ApplyDeps,
  repo: Repository,
  proposal: Proposal,
  access: RepoAccess,
  comments: readonly ReviewComment[],
): Promise<ApplyAllResult> {
  if (proposal.state !== 'open' || !proposal.sameRepo || !access.canPush) {
    throw new PermissionError('only people who can change this repository can apply suggestions to this proposal');
  }
  const reasons = new Map<number, SkipReason>();
  const byPath = new Map<string, Planned[]>();
  for (const comment of comments) {
    const replacement = parseSuggestion(comment.body);
    if (replacement === undefined) continue;
    if (comment.line === null || comment.side !== 'RIGHT') {
      reasons.set(comment.id, 'outdated');
      continue;
    }
    const start = comment.startLine ?? comment.line;
    let expected: string[];
    try {
      expected = expectedLines(comment.diffHunk, comment.line - start + 1);
    } catch {
      reasons.set(comment.id, 'outdated');
      continue;
    }
    const list = byPath.get(comment.path) ?? [];
    list.push({ comment, start, end: comment.line, expected, replacement });
    byPath.set(comment.path, list);
  }

  const changes: { path: string; content: string }[] = [];
  const applied = new Set<number>();
  for (const [path, planned] of byPath) {
    const original = await deps.repos.readFile(repo, path, proposal.headSha);
    const taken: Planned[] = [];
    for (const p of planned) {
      if (taken.some((t) => p.start <= t.end && t.start <= p.end)) {
        reasons.set(p.comment.id, 'overlap');
        continue;
      }
      try {
        // Checked against the head text; the replacement itself comes later.
        replaceLines(original, p.start, p.end, p.expected, p.replacement);
        taken.push(p);
      } catch (err) {
        if (!(err instanceof SuggestionMismatchError)) throw err;
        reasons.set(p.comment.id, 'changed');
      }
    }
    if (!taken.length) continue;
    // Bottom to top, so earlier line numbers stay valid.
    let content = original;
    for (const p of [...taken].sort((a, b) => b.start - a.start)) content = replaceLines(content, p.start, p.end, p.expected, p.replacement);
    changes.push({ path, content });
    for (const p of taken) applied.add(p.comment.id);
  }

  const appliedList = comments.filter((c) => applied.has(c.id));
  const skipped = comments.flatMap((c) => {
    const reason = reasons.get(c.id);
    return reason ? [{ comment: c, reason }] : [];
  });
  if (!changes.length) return { applied: [], skipped };

  const trailers = [...new Set(appliedList.flatMap((c) => (c.author ? [coAuthorTrailer(c.author)] : [])).filter((t): t is string => !!t))];
  const title = appliedList.length === 1 ? 'Apply suggestion' : `Apply ${appliedList.length} suggestions`;
  const message = trailers.length ? `${title}\n\n${trailers.join('\n')}` : title;
  const sha = await deps.reviews.commitToProposal(repo, proposal, changes, message, proposal.headSha);
  return { sha, applied: appliedList, skipped };
}

/** One plain-text line for the notice: what went in, and each skipped suggestion with its reason. */
export function applyAllSummary(result: ApplyAllResult, m: Messages['applyAll']): string {
  const head = result.sha ? m.done(result.applied.length) : m.nothing;
  if (!result.skipped.length) return head;
  const items = result.skipped.map(({ comment, reason }) =>
    m.item(comment.path, comment.line === null ? '?' : String(comment.line), comment.author?.login ?? '?', m.reason[reason]),
  );
  return `${head} ${m.skipped(result.skipped.length)} ${items.join('; ')}`;
}
