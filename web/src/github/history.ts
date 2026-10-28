import { RejectedError, type ChangedFile, type Repository } from '../domain';
import { isValidTagName, toVersion, type GhCommit, type Label, type Version } from '../history/versions';
import { GitHubClient, type TokenSource } from './client';
import { refPath, repoBase, seg } from './git';

// Endpoints and the GitHub App permission each one needs (user access token):
//   commits, tags, compare, git/trees (GET)   Contents: read
//   git/refs (POST), git/refs/tags/* (DELETE)  Contents: write
// A label is a lightweight tag: a ref `refs/tags/<name>` straight at a commit.

export interface Comparison {
  base: string;
  head: string;
  /** Versions (commits) between base and head. */
  commits: number;
  files: ChangedFile[];
  /** GitHub lists at most 300 changed files. */
  truncated: boolean;
}

export interface HistoryGateway {
  /** One page (30 versions) of the default branch, newest first. */
  versions(repo: Repository, page: number): Promise<{ versions: Version[]; more: boolean }>;
  labels(repo: Repository): Promise<Label[]>;
  compare(repo: Repository, base: string, head: string): Promise<Comparison>;
  /** Blob SHA per file path at a commit. */
  tree(repo: Repository, sha: string): Promise<{ blobs: Record<string, string>; truncated: boolean }>;
  /** Throws RejectedError for an invalid name or one that exists already. */
  addLabel(repo: Repository, name: string, sha: string): Promise<void>;
  removeLabel(repo: Repository, name: string): Promise<void>;
}

export interface GitHubHistoryGatewayOptions {
  tokens: TokenSource;
  fetch?: typeof globalThis.fetch;
}

interface GhFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

const PAGE = 30;
const MAX_COMPARE_FILES = 300;

export function createGitHubHistoryGateway(options: GitHubHistoryGatewayOptions): HistoryGateway {
  const gh = new GitHubClient(options.tokens, options.fetch ?? globalThis.fetch.bind(globalThis));
  const checked = (name: string) => {
    if (!isValidTagName(name)) throw new RejectedError(`invalid label name`);
    return name;
  };

  return {
    async versions(repo, page) {
      const res = await gh.request<GhCommit[]>(`${repoBase(repo)}/commits?sha=${seg(repo.defaultBranch)}&per_page=${PAGE}&page=${page}`, {
        repositoryId: repo.id,
      });
      const more = /rel="next"/.test(res.headers.get('Link') ?? '');
      return { versions: (Array.isArray(res.data) ? res.data : []).map(toVersion), more };
    },

    labels(repo) {
      return gh.paginate(
        `${repoBase(repo)}/tags?per_page=100`,
        (page: { name: string; commit: { sha: string } }[]) => page.map((t) => ({ name: t.name, sha: t.commit.sha })),
        repo.id,
      );
    },

    async compare(repo, base, head) {
      const { data } = await gh.request<{ total_commits?: number; files?: GhFile[] }>(
        `${repoBase(repo)}/compare/${seg(base)}...${seg(head)}?per_page=100`,
        { repositoryId: repo.id },
      );
      const files = (data.files ?? []).map(toChangedFile);
      return { base, head, commits: data.total_commits ?? 0, files, truncated: files.length >= MAX_COMPARE_FILES };
    },

    async tree(repo, sha) {
      const { data } = await gh.request<{ truncated: boolean; tree: { path: string; type: string; sha?: string }[] }>(
        `${repoBase(repo)}/git/trees/${seg(sha)}?recursive=1`,
        { repositoryId: repo.id },
      );
      const blobs: Record<string, string> = {};
      for (const e of data.tree) if (e.type === 'blob' && typeof e.sha === 'string') blobs[e.path] = e.sha;
      return { blobs, truncated: data.truncated };
    },

    async addLabel(repo, name, sha) {
      await gh.request(`${repoBase(repo)}/git/refs`, {
        repositoryId: repo.id,
        method: 'POST',
        body: { ref: `refs/tags/${checked(name)}`, sha },
      });
    },

    async removeLabel(repo, name) {
      await gh.request(`${repoBase(repo)}/git/refs/tags/${refPath(checked(name))}`, { repositoryId: repo.id, method: 'DELETE' });
    },
  };
}

function toChangedFile(f: GhFile): ChangedFile {
  const file: ChangedFile = { path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions };
  if (f.previous_filename) file.previousPath = f.previous_filename;
  if (typeof f.patch === 'string') file.patch = f.patch;
  return file;
}

/**
 * The zip of a version, on github.com. Not fetched by galley: the API's
 * `/zipball/{ref}` redirects to codeload.github.com, which only allows
 * render.githubusercontent.com as a CORS origin, so the browser opens this
 * link in a new tab with the person's own github.com sign in instead.
 */
export function zipUrl(repo: Repository, sha: string): string {
  return `https://github.com/${seg(repo.owner)}/${seg(repo.name)}/archive/${seg(sha)}.zip`;
}
