import {
  ConflictError,
  GatewayError,
  NotFoundError,
  NotTextError,
  type FileChange,
  type RepoGateway,
  type Repository,
  type SaveResult,
  type WorkingState,
} from '../domain';
import { GitHubClient, type TokenSource } from './client';

export interface GitHubGatewayOptions {
  tokens: TokenSource;
  fetch?: typeof globalThis.fetch;
}

interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
}

interface GhRef {
  object: { sha: string };
}

interface GhPull {
  html_url: string;
  merged_at: string | null;
  head: { sha: string };
}

interface GhTree {
  truncated: boolean;
  tree: { path: string; type: string; mode: string }[];
}

const seg = encodeURIComponent;
const refPath = (branch: string) => branch.split('/').map(seg).join('/');

/**
 * RepoGateway backed by the GitHub REST API, called directly from the browser
 * with the user's access token. Each user edits on the branch `galley/<login>`.
 */
export function createGitHubGateway(options: GitHubGatewayOptions): RepoGateway {
  const gh = new GitHubClient(options.tokens, options.fetch ?? globalThis.fetch.bind(globalThis));
  let login: Promise<string> | undefined;

  const userLogin = (): Promise<string> => {
    login ??= gh.request<{ login: string }>('/user').then((r) => r.data.login);
    login.catch(() => (login = undefined));
    return login;
  };
  const base = (repo: Repository) => `/repos/${seg(repo.owner)}/${seg(repo.name)}`;
  const workingBranch = async () => `galley/${await userLogin()}`;

  /** Returns the commit SHA a branch points at, or undefined if it does not exist. */
  const branchHead = async (repo: Repository, branch: string): Promise<string | undefined> => {
    const res = await gh.request<GhRef>(`${base(repo)}/git/ref/heads/${refPath(branch)}`, {
      repositoryId: repo.id,
      allow: [404],
    });
    return res.status === 404 ? undefined : res.data.object.sha;
  };

  const pulls = (repo: Repository, branch: string, query: string) =>
    gh.request<GhPull[]>(
      `${base(repo)}/pulls?state=${query}&head=${seg(`${repo.owner}:${branch}`)}${
        query === 'closed' ? '&sort=updated&direction=desc' : ''
      }&per_page=1`,
      { repositoryId: repo.id },
    );

  /**
   * Brings an existing working branch in line with work already merged.
   * - Only behind the default branch: fast-forward it (never forced).
   * - Diverged with no open pull request, and the latest closed one was merged
   *   at exactly this head (squash or rebase merge): delete it.
   * Returns the head to open, or undefined if the branch was deleted.
   */
  const catchUp = async (repo: Repository, branch: string, head: string): Promise<string | undefined> => {
    const { data } = await gh.request<{ ahead_by: number; behind_by: number; base_commit: { sha: string } }>(
      `${base(repo)}/compare/${refPath(repo.defaultBranch)}...${refPath(branch)}`,
      { repositoryId: repo.id },
    );
    const ref = `${base(repo)}/git/refs/heads/${refPath(branch)}`;
    if (data.behind_by === 0) return head;
    if (data.ahead_by === 0) {
      const res = await gh.request(ref, {
        repositoryId: repo.id,
        method: 'PATCH',
        allow: [422],
        body: { sha: data.base_commit.sha, force: false },
      });
      // 422: the branch moved meanwhile; open whatever it points at now.
      if (res.status === 422) return (await branchHead(repo, branch)) ?? head;
      return data.base_commit.sha;
    }
    if ((await pulls(repo, branch, 'open')).data.length > 0) return head;
    const last = (await pulls(repo, branch, 'closed')).data[0];
    if (!last?.merged_at || last.head.sha !== head) return head;
    await gh.request(ref, { repositoryId: repo.id, method: 'DELETE', allow: [404, 422] });
    return undefined;
  };

  /** Base64 content of a file up to 1 MB (GitHub's limit for inline content). */
  const contents = async (repo: Repository, path: string, ref: string): Promise<string> => {
    const encodedPath = path.split('/').map(seg).join('/');
    const { data } = await gh.request<{ type?: string; encoding?: string; content?: string }>(
      `${base(repo)}/contents/${encodedPath}?ref=${seg(ref)}`,
      { repositoryId: repo.id },
    );
    if (data.type !== 'file') throw new NotFoundError(`${path} is not a file`);
    if (data.encoding !== 'base64' || data.content === undefined) {
      throw new GatewayError(`${path} is too large to open`);
    }
    return data.content;
  };

  return {
    async listRepositories() {
      const installations = await gh.paginate(
        '/user/installations?per_page=100',
        (page: { installations: { id: number }[] }) => page.installations,
      );
      const repos: Repository[] = [];
      for (const { id } of installations) {
        const page = await gh.paginate(
          `/user/installations/${id}/repositories?per_page=100`,
          (p: { repositories: GhRepo[] }) => p.repositories,
        );
        repos.push(...page.map(toRepository));
      }
      return repos;
    },

    async openRepository(repo): Promise<WorkingState> {
      const branch = await workingBranch();
      let headSha = await branchHead(repo, branch);
      if (headSha !== undefined) headSha = await catchUp(repo, branch, headSha);
      const branchExists = headSha !== undefined;
      headSha ??= await branchHead(repo, repo.defaultBranch);
      if (headSha === undefined) throw new NotFoundError(`branch ${repo.defaultBranch} not found`);
      const { data } = await gh.request<GhTree>(`${base(repo)}/git/trees/${seg(headSha)}?recursive=1`, {
        repositoryId: repo.id,
      });
      const files = data.tree.filter((e) => e.type === 'blob').map((e) => e.path);
      return { branch, branchExists, headSha, files, truncated: data.truncated };
    },

    async readFile(repo, path, ref) {
      return decodeBase64Utf8(await contents(repo, path, ref));
    },

    async readBytes(repo, path, ref) {
      return decodeBase64(await contents(repo, path, ref));
    },

    async save(repo, changes, message, expectedHeadSha): Promise<SaveResult> {
      if (changes.length === 0) throw new GatewayError('nothing to save');
      const branch = await workingBranch();
      const current = await branchHead(repo, branch);
      if (current !== undefined && current !== expectedHeadSha) {
        throw new ConflictError(`${branch} moved since it was opened`);
      }
      const opts = { repositoryId: repo.id, method: 'POST' };
      const parent = await gh.request<{ tree: { sha: string } }>(
        `${base(repo)}/git/commits/${seg(expectedHeadSha)}`,
        { repositoryId: repo.id },
      );
      const baseTree = await gh.request<GhTree>(
        `${base(repo)}/git/trees/${seg(parent.data.tree.sha)}?recursive=1`,
        { repositoryId: repo.id },
      );
      const modes = new Map(baseTree.data.tree.map((e) => [e.path, e.mode]));
      const tree = await gh.request<{ sha: string }>(`${base(repo)}/git/trees`, {
        ...opts,
        body: {
          base_tree: parent.data.tree.sha,
          tree: changes.map((c) => toTreeEntry(c, modes.get(c.path))),
        },
      });
      const commit = await gh.request<{ sha: string }>(`${base(repo)}/git/commits`, {
        ...opts,
        body: { message, tree: tree.data.sha, parents: [expectedHeadSha] },
      });
      const commitSha = commit.data.sha;

      // Never force: a create fails if the branch appeared meanwhile, and an
      // update fails unless it is a fast-forward. Both answer 422.
      const ref =
        current === undefined
          ? await gh.request(`${base(repo)}/git/refs`, {
              ...opts,
              allow: [422],
              body: { ref: `refs/heads/${branch}`, sha: commitSha },
            })
          : await gh.request(`${base(repo)}/git/refs/heads/${refPath(branch)}`, {
              ...opts,
              method: 'PATCH',
              allow: [422],
              body: { sha: commitSha, force: false },
            });
      if (ref.status === 422) throw new ConflictError(`${branch} moved since it was opened`);

      // The commit has landed; a failing pull request step must not hide that,
      // or a retry would report a false conflict.
      const pullRequestUrl = await ensurePullRequest(repo, branch, message).catch(() => undefined);
      return { commitSha, pullRequestUrl };
    },
  };

  async function ensurePullRequest(repo: Repository, branch: string, message: string): Promise<string> {
    const existing = (await pulls(repo, branch, 'open')).data[0];
    if (existing) return existing.html_url;
    const created = await gh.request<{ html_url: string }>(`${base(repo)}/pulls`, {
      repositoryId: repo.id,
      method: 'POST',
      allow: [422],
      body: {
        title: message.split('\n')[0]?.trim() || `Edits from ${branch}`,
        head: branch,
        base: repo.defaultBranch,
        body: 'Opened by galley. Later saves add commits to this pull request.',
      },
    });
    if (created.status !== 422) return created.data.html_url;
    // 422: most likely opened concurrently; look it up again.
    const again = (await pulls(repo, branch, 'open')).data[0];
    if (!again) throw new GatewayError('could not open a pull request');
    return again.html_url;
  }
}

function toRepository(r: GhRepo): Repository {
  return {
    id: r.id,
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    private: r.private,
  };
}

/** Existing files keep their mode (for example 100755); new files get 100644. */
function toTreeEntry(change: FileChange, mode = '100644') {
  return { path: change.path, mode, type: 'blob', content: change.content };
}

/** Decodes GitHub's base64, which has line breaks, into bytes. */
export function decodeBase64(content: string): Uint8Array {
  return Uint8Array.from(atob(content.replace(/\s/g, '')), (c) => c.charCodeAt(0));
}

/**
 * Decodes GitHub's base64 (with line breaks) into UTF-8 text. Invalid UTF-8 is
 * rejected instead of replaced, so saving can never corrupt the file. A BOM is
 * kept as U+FEFF; inline tree content is sent as UTF-8, so it is written back.
 */
export function decodeBase64Utf8(content: string): string {
  const bytes = decodeBase64(content);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new NotTextError('not a UTF-8 text file');
  }
}
