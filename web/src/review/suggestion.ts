import {
  GatewayError,
  PermissionError,
  SuggestionMismatchError,
  type Person,
  type Proposal,
  type RepoAccess,
  type RepoGateway,
  type Repository,
  type ReviewComment,
  type ReviewGateway,
} from '../domain';

// GitHub has no REST endpoint to apply a suggestion. galley applies it as an
// ordinary commit on the proposal's head branch, the way GitHub's own button
// does: exactly the commented lines are replaced, and the suggester is credited
// with a Co-authored-by trailer.

// As in CommonMark: up to 3 spaces of indent, and a closing fence of the same
// character that is at least as long as the opening one.
const SUGGESTION = /^ {0,3}((`|~)\2{2,})suggestion[^\n]*\n([\s\S]*?)^ {0,3}\1\2*[ \t]*$/m;

/** The content of the first ```suggestion block, or undefined. '' deletes the lines. */
export function parseSuggestion(body: string): string | undefined {
  const match = SUGGESTION.exec(body.replace(/\r\n/g, '\n'));
  if (!match) return undefined;
  const content = match[3] ?? '';
  return content.endsWith('\n') ? content.slice(0, -1) : content;
}

/** The comment text around the suggestion block. */
export function withoutSuggestion(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(SUGGESTION, '').trim();
}

/** A suggestion block pre-filled with the current lines, fenced so they cannot close it. */
export function suggestionBlock(lines: readonly string[]): string {
  const longest = Math.max(2, ...lines.flatMap((l) => (l.match(/`+/g) ?? []).map((run) => run.length)));
  const fence = '`'.repeat(longest + 1);
  return `${fence}suggestion\n${lines.join('\n')}\n${fence}`;
}

/**
 * The new-side lines the suggester saw: GitHub's `diff_hunk` ends at the
 * commented line, so the last `count` lines that are not deletions.
 */
export function expectedLines(diffHunk: string, count: number): string[] {
  const right = diffHunk
    .split('\n')
    .filter((l) => !l.startsWith('@@') && !l.startsWith('-') && !l.startsWith('\\'))
    .map((l) => l.slice(1).replace(/\r$/, ''));
  if (count < 1 || right.length < count) {
    throw new SuggestionMismatchError('the suggestion covers lines that are not in the diff');
  }
  return right.slice(-count);
}

/**
 * Replaces lines `start`..`end` (1-based, inclusive) with `replacement`, only if
 * they still read `expected`. New lines get the file's line ending (CRLF if the
 * file uses it), and a last line without a newline stays without one.
 */
export function replaceLines(
  text: string,
  start: number,
  end: number,
  expected: readonly string[],
  replacement: string,
): string {
  const lines = text.split('\n');
  const plain = lines.slice(start - 1, end).map((l) => l.replace(/\r$/, ''));
  if (start < 1 || end > lines.length || plain.length !== expected.length || plain.some((l, i) => l !== expected[i])) {
    throw new SuggestionMismatchError('the lines changed since the suggestion was written');
  }
  // `lines` ends with the text after the last newline: it has no line ending.
  const endsFile = end === lines.length;
  const crlf = text.includes('\r\n');
  const next = replacement === '' ? [] : replacement.split('\n');
  const withEndings = next.map((l, i) => (crlf && !(endsFile && i === next.length - 1) ? `${l}\r` : l));
  lines.splice(start - 1, end - start + 1, ...withEndings);
  return lines.join('\n');
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

/** `Co-authored-by` with the GitHub noreply address, or undefined for an unexpected login. */
export function coAuthorTrailer(person: Person): string | undefined {
  if (!LOGIN.test(person.login) || !Number.isSafeInteger(person.id) || person.id <= 0) return undefined;
  return `Co-authored-by: ${person.login} <${person.id}+${person.login}@users.noreply.github.com>`;
}

export interface ApplyDeps {
  repos: Pick<RepoGateway, 'readFile'>;
  reviews: Pick<ReviewGateway, 'commitToProposal'>;
}

/** Applies a suggestion as one fast-forward commit on the proposal head. Returns the commit SHA. */
export async function applySuggestion(
  deps: ApplyDeps,
  repo: Repository,
  proposal: Proposal,
  access: RepoAccess,
  comment: ReviewComment,
): Promise<string> {
  if (proposal.state !== 'open' || !proposal.sameRepo || !access.canPush) {
    throw new PermissionError('only people who can change this repository can apply suggestions to this proposal');
  }
  const replacement = parseSuggestion(comment.body);
  if (replacement === undefined) throw new GatewayError('this comment has no suggestion');
  if (comment.line === null || comment.side !== 'RIGHT') {
    throw new SuggestionMismatchError('the suggestion refers to an earlier version of the file');
  }
  const start = comment.startLine ?? comment.line;
  const expected = expectedLines(comment.diffHunk, comment.line - start + 1);
  const text = await deps.repos.readFile(repo, comment.path, proposal.headSha);
  const content = replaceLines(text, start, comment.line, expected, replacement);
  const who = comment.author;
  const trailer = who && coAuthorTrailer(who);
  const message = `Apply suggestion${who && trailer ? ` from @${who.login}` : ''}${trailer ? `\n\n${trailer}` : ''}`;
  return deps.reviews.commitToProposal(repo, proposal, [{ path: comment.path, content }], message, proposal.headSha);
}
