import { useEffect, useState } from 'preact/hooks';
import type { Repository } from '../../domain';
import type { CiGateway } from '../../github/ci';
import { POLL_MS, shouldPoll } from '../../ci/poll';
import type { CiState, CiStatus } from '../../ci/status';
import { useT } from '../../i18n';

const TONE: Record<Exclude<CiState, 'none'>, string> = {
  running: 'chip chip-warn ci-chip',
  success: 'chip chip-ok ci-chip',
  failure: 'chip chip-danger ci-chip',
};

/** Compiling… / Compiled / Failed, linking to the build on GitHub. Nothing without CI. */
export function CiChip({ status }: { status?: CiStatus }) {
  const t = useT();
  if (!status || status.state === 'none') return null;
  const label = t.ci[status.state];
  if (!status.url) return <span class={TONE[status.state]}>{label}</span>;
  return (
    <a class={TONE[status.state]} href={status.url} target="_blank" rel="noopener noreferrer" title={t.ci.runTitle} data-ci={status.state}>
      {label}
    </a>
  );
}

/** The CI status of a commit, refreshed every 20 s while it runs and the page is visible. */
export function useCiStatus(ci: CiGateway | undefined, repo: Repository, sha: string | undefined): CiStatus | undefined {
  const [status, setStatus] = useState<CiStatus>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setStatus(undefined);
  }, [sha]);

  useEffect(() => {
    if (!ci || !sha) return;
    let active = true;
    // No CI permission or no checks: show nothing rather than an error.
    ci.status(repo, sha).then((s) => active && setStatus(s), () => active && setStatus({ state: 'none' }));
    return () => {
      active = false;
    };
  }, [ci, repo, sha, tick]);

  useEffect(() => {
    if (status?.state !== 'running') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      if (shouldPoll(status.state, document.visibilityState)) timer = setTimeout(() => setTick((n) => n + 1), POLL_MS);
    };
    arm();
    document.addEventListener('visibilitychange', arm);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', arm);
    };
  }, [status]);

  return status;
}

/** A self-refreshing chip for one commit. */
export function LiveCiChip({ ci, repo, sha }: { ci?: CiGateway; repo: Repository; sha?: string }) {
  return <CiChip status={useCiStatus(ci, repo, sha)} />;
}
