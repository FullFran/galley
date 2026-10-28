import type { Repository } from '../domain';
import { pickArtifact, rankBranchRuns, rankShaRuns, type Artifact, type WorkflowRun } from '../ci/builds';
import { ciStatus, type CiStatus } from '../ci/status';
import { extractDocuments, type Documents } from '../ci/unzip';
import { githubUrl } from '../review/status';
import { GitHubClient, type TokenSource } from './client';

// Endpoints and the GitHub App permission each one needs (user access token):
//   commits/{sha}/check-runs (GET)                     Checks: read
//   actions/runs, runs/{id}/artifacts (GET)            Actions: read
//   actions/artifacts/{id}/zip (GET, redirect to blob) Actions: read

/** Which build: the head commit of a proposal, or the latest good build of a branch. */
export type BuildTarget = { sha: string } | { branch: string };

export type DocumentsResult =
  | { kind: 'ready'; docs: Documents; runUrl?: string }
  /** The artifact is gone (GitHub keeps them for a limited time). */
  | { kind: 'expired'; runUrl?: string }
  /** The commit is still compiling. */
  | { kind: 'running'; runUrl?: string }
  /** No finished build with an artifact. */
  | { kind: 'none'; runUrl?: string }
  /** The artifact holds no PDF. */
  | { kind: 'empty'; runUrl?: string };

export interface CiGateway {
  status(repo: Repository, sha: string): Promise<CiStatus>;
  documents(repo: Repository, target: BuildTarget): Promise<DocumentsResult>;
}

export interface GitHubCiGatewayOptions {
  tokens: TokenSource;
  fetch?: typeof globalThis.fetch;
}

interface GhCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
}

interface GhRun {
  id: number;
  head_sha: string;
  head_branch: string | null;
  event: string;
  status: string | null;
  conclusion: string | null;
  created_at: string;
  html_url?: string;
}

interface GhArtifact {
  id: number;
  name: string;
  expired: boolean;
  size_in_bytes: number;
}

/** Runs whose artifacts are looked at before giving up. */
const MAX_RUNS = 5;

const toRun = (r: GhRun): WorkflowRun => ({
  id: r.id,
  headSha: r.head_sha,
  headBranch: r.head_branch ?? '',
  event: r.event,
  status: r.status ?? '',
  conclusion: r.conclusion,
  createdAt: r.created_at,
  htmlUrl: githubUrl(r.html_url),
});

const toArtifact = (a: GhArtifact): Artifact => ({ id: a.id, name: a.name, expired: a.expired, sizeInBytes: a.size_in_bytes });

export function createGitHubCiGateway(options: GitHubCiGatewayOptions): CiGateway {
  const gh = new GitHubClient(options.tokens, options.fetch ?? globalThis.fetch.bind(globalThis));
  const base = (repo: Repository) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

  const runs = async (repo: Repository, target: BuildTarget): Promise<WorkflowRun[]> => {
    const query =
      'sha' in target
        ? `head_sha=${encodeURIComponent(target.sha)}`
        : `branch=${encodeURIComponent(target.branch)}&status=success`;
    const res = await gh.request<{ workflow_runs: GhRun[] }>(`${base(repo)}/actions/runs?${query}&per_page=30`, { repositoryId: repo.id });
    return res.data.workflow_runs.map(toRun);
  };

  return {
    async status(repo, sha) {
      const res = await gh.request<{ check_runs: GhCheckRun[] }>(`${base(repo)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`, {
        repositoryId: repo.id,
      });
      return ciStatus(res.data.check_runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, htmlUrl: r.html_url ?? undefined })));
    },

    async documents(repo, target) {
      const all = await runs(repo, target);
      const ranked = 'sha' in target ? rankShaRuns(all, target.sha) : rankBranchRuns(all, target.branch);
      if (ranked.length === 0) {
        const going = 'sha' in target ? all.find((r) => r.headSha === target.sha && r.status !== 'completed') : undefined;
        return going ? { kind: 'running', runUrl: going.htmlUrl } : { kind: 'none' };
      }
      let expired: WorkflowRun | undefined;
      for (const run of ranked.slice(0, MAX_RUNS)) {
        const res = await gh.request<{ artifacts: GhArtifact[] }>(`${base(repo)}/actions/runs/${run.id}/artifacts?per_page=100`, { repositoryId: repo.id });
        const pick = pickArtifact(res.data.artifacts.map(toArtifact));
        if (pick.kind === 'expired') expired ??= run;
        if (pick.kind !== 'found') continue;
        const zip = await gh.downloadArtifact(`${base(repo)}/actions/artifacts/${pick.artifact.id}/zip`, repo.id);
        if (zip.kind === 'expired') return { kind: 'expired', runUrl: run.htmlUrl };
        const docs = await extractDocuments(zip.bytes);
        return docs.pdf ? { kind: 'ready', docs, runUrl: run.htmlUrl } : { kind: 'empty', runUrl: run.htmlUrl };
      }
      return expired ? { kind: 'expired', runUrl: expired.htmlUrl } : { kind: 'none', runUrl: ranked[0]?.htmlUrl };
    },
  };
}
