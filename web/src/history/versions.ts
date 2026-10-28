// Versions of the paper: the commits of the default branch, newest first.
// Labels are git tags. Commit messages and names come from other people and
// are untrusted: render them as text only.

export interface GhCommit {
  sha: string;
  commit: {
    message: string;
    author?: { name?: string | null; date?: string | null } | null;
    committer?: { date?: string | null } | null;
  };
  author?: { login: string } | null;
  parents?: { sha: string }[];
  html_url?: string;
}

/** A label on a version: a tag name and the commit it points at. */
export interface Label {
  name: string;
  sha: string;
}

export interface Version {
  sha: string;
  /** First line of the commit message. */
  title: string;
  /** GitHub login, else the git author name. */
  author?: string;
  /** ISO 8601 date the version was made (committer date). */
  date: string;
  /** Set when this version is a merged proposal (merge or squash commit). */
  proposal?: { number: number; title: string };
  /** True for merge commits (more than one parent). */
  merge: boolean;
  labels: string[];
  htmlUrl?: string;
}

const MERGED = /^Merge pull request #(\d+) from \S+/;
const SQUASHED = /^(.*\S)\s+\(#(\d+)\)$/;

/** "Merge pull request #N from …" (title on a later line) or "Title (#N)" (squash merge). */
export function proposalOf(message: string): { number: number; title: string } | undefined {
  const lines = message.split('\n');
  const first = lines[0]?.trim() ?? '';
  const merged = MERGED.exec(first);
  if (merged) {
    const title = lines.slice(1).find((l) => l.trim() !== '')?.trim() ?? '';
    return { number: Number(merged[1]), title };
  }
  const squashed = SQUASHED.exec(first);
  if (squashed) return { number: Number(squashed[2]), title: squashed[1] ?? '' };
  return undefined;
}

export function toVersion(c: GhCommit): Version {
  const title = c.commit.message.split('\n')[0]?.trim() ?? '';
  const proposal = proposalOf(c.commit.message);
  const author = c.author?.login ?? c.commit.author?.name ?? undefined;
  const version: Version = {
    sha: c.sha,
    title,
    date: c.commit.committer?.date ?? c.commit.author?.date ?? '',
    merge: (c.parents?.length ?? 0) > 1,
    labels: [],
  };
  if (author) version.author = author;
  if (proposal) version.proposal = proposal;
  if (typeof c.html_url === 'string' && c.html_url.startsWith('https://github.com/')) version.htmlUrl = c.html_url;
  return version;
}

/** Puts every label on the version it points at (names sorted). */
export function withLabels(versions: Version[], labels: Label[]): Version[] {
  const bySha = new Map<string, string[]>();
  for (const l of labels) bySha.set(l.sha, [...(bySha.get(l.sha) ?? []), l.name]);
  return versions.map((v) => ({ ...v, labels: [...(bySha.get(v.sha) ?? [])].sort() }));
}

export const shortSha = (sha: string) => sha.slice(0, 7);

export type TagNameProblem = 'empty' | 'invalid' | 'tooLong' | 'taken';

const MAX_TAG = 100;

/**
 * Checks a label name against git's ref name rules (git check-ref-format),
 * a bit stricter: no spaces or control characters at all.
 */
export function tagNameProblem(name: string, existing: readonly string[]): TagNameProblem | undefined {
  if (name.trim() === '') return 'empty';
  if (name.length > MAX_TAG) return 'tooLong';
  if (!isValidTagName(name)) return 'invalid';
  if (existing.includes(name)) return 'taken';
  return undefined;
}

export function isValidTagName(name: string): boolean {
  if (name === '' || name.length > MAX_TAG || name === '@') return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f~^:?*[\\]/.test(name)) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  return name.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}
