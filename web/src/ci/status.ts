import { githubUrl } from '../review/status';

/** One GitHub check run of a commit (a CI job), as galley needs it. */
export interface CheckRun {
  name: string;
  /** `queued`, `in_progress`, `completed`, and GitHub's newer `waiting`, `pending`, `requested`. */
  status: string;
  /** Set once completed: `success`, `failure`, `skipped`, `cancelled`, ... */
  conclusion: string | null;
  htmlUrl?: string;
}

/** What the compile chip says: still compiling, compiled, failed, or no CI at all. */
export type CiState = 'running' | 'success' | 'failure' | 'none';

export interface CiStatus {
  state: CiState;
  /** The run to look at on GitHub (the running or failed one first). */
  url?: string;
}

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
const IGNORED = new Set(['skipped', 'neutral']);

/** Sums up the check runs of a commit: running beats failed, failed beats compiled. */
export function ciStatus(runs: CheckRun[]): CiStatus {
  const running = runs.find((r) => r.status !== 'completed');
  if (running) return withUrl('running', running);
  const failed = runs.find((r) => r.conclusion !== null && FAILED.has(r.conclusion));
  if (failed) return withUrl('failure', failed);
  const passed = runs.find((r) => r.conclusion !== null && !IGNORED.has(r.conclusion));
  if (passed) return withUrl('success', passed);
  return { state: 'none' };
}

function withUrl(state: CiState, run: CheckRun): CiStatus {
  const url = githubUrl(run.htmlUrl);
  return url ? { state, url } : { state };
}
