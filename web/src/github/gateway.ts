import {
  ConflictError,
  GatewayError,
  NotFoundError,
  NotTextError,
  type RepoGateway,
  type Repository,
  type SaveResult,
  type WorkingState,
} from '../domain';
import { GitHubClient, type TokenSource } from './client';
import { branchHead as headOf, createCommit, fastForward, listTree, refPath, repoBase, seg } from './git';

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
  pushed_at?: string | null;
  updated_at?: string | null;
}

interface GhPull {
  html_url: string;
  merged_at: string | null;
  head: { sha: string };
}


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
  const base = repoBase;
  const workingBranch = async () => `galley/${await userLogin()}`;

  const branchHead = (repo: Repository, branch: string) => headOf(gh, repo, branch);

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
      const { files, truncated } = await listTree(gh, repo, headSha);
      return { branch, branchExists, headSha, files, truncated };
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
      const commitSha = await createCommit(gh, repo, changes, message, expectedHeadSha);

      // Never force: a create fails if the branch appeared meanwhile, and an
      // update fails unless it is a fast-forward. Both answer 422.
      const moved =
        current === undefined
          ? (
              await gh.request(`${base(repo)}/git/refs`, {
                repositoryId: repo.id,
                method: 'POST',
                allow: [422],
                body: { ref: `refs/heads/${branch}`, sha: commitSha },
              })
            ).status !== 422
          : await fastForward(gh, repo, branch, commitSha);
      if (!moved) throw new ConflictError(`${branch} moved since it was opened`);

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
    updatedAt: r.pushed_at ?? r.updated_at ?? undefined,
  };
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
