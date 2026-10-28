import { describe, expect, it } from 'vitest';
import { pickArtifact, pickBranchRun, pickShaRun, type Artifact, type WorkflowRun } from './builds';

const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 1,
  headSha: 'abc',
  headBranch: 'galley/ana',
  event: 'pull_request',
  status: 'completed',
  conclusion: 'success',
  createdAt: '2026-10-28T10:00:00Z',
  htmlUrl: 'https://github.com/o/r/actions/runs/1',
  ...over,
});

const artifact = (over: Partial<Artifact> = {}): Artifact => ({ id: 7, name: 'paper-pdf-docx', expired: false, sizeInBytes: 1000, ...over });

describe('pickShaRun', () => {
  it('picks the latest successful run of the commit', () => {
    const runs = [
      run({ id: 1, createdAt: '2026-10-28T09:00:00Z' }),
      run({ id: 2, createdAt: '2026-10-28T11:00:00Z' }),
      run({ id: 3, createdAt: '2026-10-28T12:00:00Z', conclusion: 'failure' }),
      run({ id: 4, createdAt: '2026-10-28T13:00:00Z', headSha: 'other' }),
    ];
    expect(pickShaRun(runs, 'abc')?.id).toBe(2);
  });

  it('falls back to the latest completed run (the artifact is uploaded before the checks fail)', () => {
    const runs = [run({ id: 1, conclusion: 'cancelled', createdAt: '2026-10-28T09:00:00Z' }), run({ id: 2, conclusion: 'failure', createdAt: '2026-10-28T10:00:00Z' })];
    expect(pickShaRun(runs, 'abc')?.id).toBe(2);
  });

  it('is undefined while the only run is still going, or without runs', () => {
    expect(pickShaRun([run({ status: 'in_progress', conclusion: null })], 'abc')).toBeUndefined();
    expect(pickShaRun([], 'abc')).toBeUndefined();
  });
});

describe('pickBranchRun', () => {
  it('picks the latest successful push or manual run of the branch', () => {
    const runs = [
      run({ id: 1, headBranch: 'main', event: 'push', createdAt: '2026-10-27T09:00:00Z' }),
      run({ id: 2, headBranch: 'main', event: 'workflow_dispatch', createdAt: '2026-10-28T09:00:00Z' }),
      run({ id: 3, headBranch: 'main', event: 'push', conclusion: 'failure', createdAt: '2026-10-28T10:00:00Z' }),
      run({ id: 4, headBranch: 'main', event: 'pull_request', createdAt: '2026-10-28T11:00:00Z' }),
      run({ id: 5, headBranch: 'dev', event: 'push', createdAt: '2026-10-28T12:00:00Z' }),
    ];
    expect(pickBranchRun(runs, 'main')?.id).toBe(2);
  });

  it('is undefined without a successful run', () => {
    expect(pickBranchRun([run({ headBranch: 'main', event: 'push', conclusion: 'failure' })], 'main')).toBeUndefined();
  });
});

describe('pickArtifact', () => {
  it('picks a live artifact, preferring one named like a PDF', () => {
    expect(pickArtifact([artifact({ id: 1, name: 'logs' }), artifact({ id: 2, name: 'paper-pdf-docx' })])).toEqual({ kind: 'found', artifact: artifact({ id: 2, name: 'paper-pdf-docx' }) });
    expect(pickArtifact([artifact({ id: 3, name: 'build' })])).toMatchObject({ kind: 'found', artifact: { id: 3 } });
  });

  it('reports expired when every artifact has expired', () => {
    expect(pickArtifact([artifact({ expired: true })])).toEqual({ kind: 'expired' });
  });

  it('skips expired ones when a live one exists', () => {
    expect(pickArtifact([artifact({ id: 1, expired: true }), artifact({ id: 2, name: 'other' })])).toMatchObject({ kind: 'found', artifact: { id: 2 } });
  });

  it('reports none without artifacts', () => {
    expect(pickArtifact([])).toEqual({ kind: 'none' });
  });
});
