// Which GitHub Actions run and artifact hold the compiled paper.

export interface WorkflowRun {
  id: number;
  headSha: string;
  headBranch: string;
  /** `push`, `pull_request`, `workflow_dispatch`, ... */
  event: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  htmlUrl?: string;
}

export interface Artifact {
  id: number;
  name: string;
  expired: boolean;
  sizeInBytes: number;
}

export type ArtifactPick = { kind: 'found'; artifact: Artifact } | { kind: 'expired' } | { kind: 'none' };

const newestFirst = (a: WorkflowRun, b: WorkflowRun) => Date.parse(b.createdAt) - Date.parse(a.createdAt);

/**
 * Completed runs of a commit, best first: successful ones newest first, then
 * the other completed ones (the paper's workflow uploads the PDF before its
 * checks can fail the job).
 */
export function rankShaRuns(runs: WorkflowRun[], sha: string): WorkflowRun[] {
  const done = runs.filter((r) => r.headSha === sha && r.status === 'completed').sort(newestFirst);
  return [...done.filter((r) => r.conclusion === 'success'), ...done.filter((r) => r.conclusion !== 'success')];
}

export function pickShaRun(runs: WorkflowRun[], sha: string): WorkflowRun | undefined {
  return rankShaRuns(runs, sha)[0];
}

/** Successful push or manual runs of a branch, newest first (pull request runs carry other content). */
export function rankBranchRuns(runs: WorkflowRun[], branch: string): WorkflowRun[] {
  return runs
    .filter((r) => r.headBranch === branch && r.status === 'completed' && r.conclusion === 'success')
    .filter((r) => r.event === 'push' || r.event === 'workflow_dispatch')
    .sort(newestFirst);
}

export function pickBranchRun(runs: WorkflowRun[], branch: string): WorkflowRun | undefined {
  return rankBranchRuns(runs, branch)[0];
}

/** A live artifact of a run, preferring one whose name mentions the PDF. */
export function pickArtifact(artifacts: Artifact[]): ArtifactPick {
  if (artifacts.length === 0) return { kind: 'none' };
  const live = artifacts.filter((a) => !a.expired);
  const artifact = live.find((a) => /pdf/i.test(a.name)) ?? live[0];
  return artifact ? { kind: 'found', artifact } : { kind: 'expired' };
}
