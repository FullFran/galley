import { describe, expect, it } from 'vitest';
import { ciStatus, type CheckRun } from './status';

const run = (over: Partial<CheckRun> = {}): CheckRun => ({
  name: 'Compilar PDF y DOCX',
  status: 'completed',
  conclusion: 'success',
  htmlUrl: 'https://github.com/o/r/actions/runs/1/job/2',
  ...over,
});

describe('ciStatus', () => {
  it('is none without check runs or statuses', () => {
    expect(ciStatus([])).toEqual({ state: 'none' });
  });

  it('is running while any check run is queued or in progress', () => {
    const s = ciStatus([run(), run({ status: 'in_progress', conclusion: null, htmlUrl: 'https://github.com/o/r/actions/runs/9' })]);
    expect(s).toEqual({ state: 'running', url: 'https://github.com/o/r/actions/runs/9' });
    expect(ciStatus([run({ status: 'queued', conclusion: null })]).state).toBe('running');
  });

  it('is failed when a completed run failed, timed out or was cancelled', () => {
    for (const conclusion of ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']) {
      expect(ciStatus([run(), run({ conclusion, htmlUrl: 'https://github.com/o/r/runs/3' })]).state).toBe('failure');
    }
    expect(ciStatus([run({ conclusion: 'failure', htmlUrl: 'https://github.com/x' })]).url).toBe('https://github.com/x');
  });

  it('is compiled when every run succeeded or was skipped', () => {
    expect(ciStatus([run(), run({ conclusion: 'skipped' }), run({ conclusion: 'neutral' })]).state).toBe('success');
  });

  it('ignores only-skipped runs', () => {
    expect(ciStatus([run({ conclusion: 'skipped' })]).state).toBe('none');
  });

  it('prefers running over failed', () => {
    expect(ciStatus([run({ conclusion: 'failure' }), run({ status: 'in_progress', conclusion: null })]).state).toBe('running');
  });

  it('keeps only github.com links', () => {
    expect(ciStatus([run({ htmlUrl: 'https://evil.example/run' })]).url).toBeUndefined();
    expect(ciStatus([run({ conclusion: 'failure', htmlUrl: 'javascript:alert(1)' })]).url).toBeUndefined();
  });
});
