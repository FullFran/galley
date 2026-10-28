import type { FileChange, Repository } from '../domain';
import type { GitHubClient } from './client';

// Git data helpers shared by the editing and the review gateways.

export const seg = encodeURIComponent;
export const refPath = (branch: string) => branch.split('/').map(seg).join('/');
export const repoBase = (repo: Repository) => `/repos/${seg(repo.owner)}/${seg(repo.name)}`;

export interface GhTree {
  truncated: boolean;
  tree: { path: string; type: string; mode: string }[];
}

/** Returns the commit SHA a branch points at, or undefined if it does not exist. */
export async function branchHead(gh: GitHubClient, repo: Repository, branch: string): Promise<string | undefined> {
  const res = await gh.request<{ object: { sha: string } }>(`${repoBase(repo)}/git/ref/heads/${refPath(branch)}`, {
    repositoryId: repo.id,
    allow: [404],
  });
  return res.status === 404 ? undefined : res.data.object.sha;
}

/** Blob paths of the tree at a commit. */
export async function listTree(gh: GitHubClient, repo: Repository, sha: string) {
  const { data } = await gh.request<GhTree>(`${repoBase(repo)}/git/trees/${seg(sha)}?recursive=1`, {
    repositoryId: repo.id,
  });
  return { files: data.tree.filter((e) => e.type === 'blob').map((e) => e.path), truncated: data.truncated };
}

/** Creates (without moving any branch) one commit with `changes` on top of `parentSha`. */
export async function createCommit(
  gh: GitHubClient,
  repo: Repository,
  changes: FileChange[],
  message: string,
  parentSha: string,
): Promise<string> {
  const base = repoBase(repo);
  const opts = { repositoryId: repo.id, method: 'POST' };
  const parent = await gh.request<{ tree: { sha: string } }>(`${base}/git/commits/${seg(parentSha)}`, {
    repositoryId: repo.id,
  });
  const baseTree = await gh.request<GhTree>(`${base}/git/trees/${seg(parent.data.tree.sha)}?recursive=1`, {
    repositoryId: repo.id,
  });
  const modes = new Map(baseTree.data.tree.map((e) => [e.path, e.mode]));
  const tree = await gh.request<{ sha: string }>(`${base}/git/trees`, {
    ...opts,
    body: { base_tree: parent.data.tree.sha, tree: changes.map((c) => toTreeEntry(c, modes.get(c.path))) },
  });
  const commit = await gh.request<{ sha: string }>(`${base}/git/commits`, {
    ...opts,
    body: { message, tree: tree.data.sha, parents: [parentSha] },
  });
  return commit.data.sha;
}

/** Moves an existing branch to `sha`, fast-forward only. False when GitHub refuses (422). */
export async function fastForward(gh: GitHubClient, repo: Repository, branch: string, sha: string): Promise<boolean> {
  const res = await gh.request(`${repoBase(repo)}/git/refs/heads/${refPath(branch)}`, {
    repositoryId: repo.id,
    method: 'PATCH',
    allow: [422],
    body: { sha, force: false },
  });
  return res.status !== 422;
}

/** Existing files keep their mode (for example 100755); new files get 100644. */
function toTreeEntry(change: FileChange, mode = '100644') {
  return { path: change.path, mode, type: 'blob', content: change.content };
}
