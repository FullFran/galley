import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import type { Repository } from '../domain';
import { fakeFetch, json, on, type Route } from '../test/fakeFetch';
import { createGitHubCiGateway } from './ci';

const GH = 'https://api.github.com';
const R = `${GH}/repos/octo/paper`;
const repo: Repository = { id: 7, owner: 'octo', name: 'paper', fullName: 'octo/paper', defaultBranch: 'main', private: true };

function gateway(routes: Route[]) {
  const tokens = { getAccessToken: vi.fn(async () => 'tok'), invalidate: vi.fn() };
  const fake = fakeFetch(routes);
  return { gw: createGitHubCiGateway({ tokens, fetch: fake.fetch }), ...fake, tokens };
}

const ghRun = (extra: Record<string, unknown> = {}) => ({
  id: 100,
  head_sha: 'h1',
  head_branch: 'galley/ana',
  event: 'pull_request',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-10-28T10:00:00Z',
  html_url: 'https://github.com/octo/paper/actions/runs/100',
  ...extra,
});

const zip = zipSync({ 'paper.pdf': strToU8('%PDF-1.7 x'), 'paper.docx': strToU8('PK') });

describe('GitHub CI gateway', () => {
  it('maps the check runs of a commit to a status', async () => {
    const { gw, tokens } = gateway([
      on('GET', `${R}/commits/h1/check-runs?per_page=100`, () =>
        json({ total_count: 1, check_runs: [{ name: 'build', status: 'in_progress', conclusion: null, html_url: 'https://github.com/octo/paper/runs/5' }] }),
      ),
    ]);
    expect(await gw.status(repo, 'h1')).toEqual({ state: 'running', url: 'https://github.com/octo/paper/runs/5' });
    expect(tokens.getAccessToken).toHaveBeenCalledWith(7);
  });

  it('finds the artifact of the latest successful run of a commit', async () => {
    const { gw } = gateway([
      on('GET', `${R}/actions/runs?head_sha=h1&per_page=30`, () =>
        json({ workflow_runs: [ghRun({ id: 99, created_at: '2026-10-28T09:00:00Z' }), ghRun()] }),
      ),
      on('GET', `${R}/actions/runs/100/artifacts?per_page=100`, () => json({ artifacts: [{ id: 5, name: 'paper-pdf-docx', expired: false, size_in_bytes: 10 }] })),
      on('GET', `${R}/actions/artifacts/5/zip`, () => new Response(zip)),
    ]);
    const result = await gw.documents(repo, { sha: 'h1' });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.runUrl).toBe('https://github.com/octo/paper/actions/runs/100');
    expect(result.docs.pdf?.name).toBe('paper.pdf');
    expect(result.docs.docx?.name).toBe('paper.docx');
  });

  it('looks for the default branch among successful runs', async () => {
    const { gw, requests } = gateway([
      on('GET', `${R}/actions/runs?branch=main&status=success&per_page=30`, () =>
        json({ workflow_runs: [ghRun({ id: 200, head_branch: 'main', event: 'push' })] }),
      ),
      on('GET', `${R}/actions/runs/200/artifacts?per_page=100`, () => json({ artifacts: [{ id: 6, name: 'pdf', expired: false, size_in_bytes: 10 }] })),
      on('GET', `${R}/actions/artifacts/6/zip`, () => new Response(zip)),
    ]);
    expect((await gw.documents(repo, { branch: 'main' })).kind).toBe('ready');
    expect(requests.map((r) => r.url)).toHaveLength(3);
  });

  it('says expired when the artifact list or the download says so', async () => {
    const listed = gateway([
      on('GET', `${R}/actions/runs?head_sha=h1&per_page=30`, () => json({ workflow_runs: [ghRun()] })),
      on('GET', `${R}/actions/runs/100/artifacts?per_page=100`, () => json({ artifacts: [{ id: 5, name: 'pdf', expired: true, size_in_bytes: 1 }] })),
    ]);
    expect(await listed.gw.documents(repo, { sha: 'h1' })).toEqual({ kind: 'expired', runUrl: 'https://github.com/octo/paper/actions/runs/100' });

    const gone = gateway([
      on('GET', `${R}/actions/runs?head_sha=h1&per_page=30`, () => json({ workflow_runs: [ghRun()] })),
      on('GET', `${R}/actions/runs/100/artifacts?per_page=100`, () => json({ artifacts: [{ id: 5, name: 'pdf', expired: false, size_in_bytes: 1 }] })),
      on('GET', `${R}/actions/artifacts/5/zip`, () => json({ message: 'gone' }, 410)),
    ]);
    expect((await gone.gw.documents(repo, { sha: 'h1' })).kind).toBe('expired');
  });

  it('says running while the only run of the commit is going', async () => {
    const { gw } = gateway([
      on('GET', `${R}/actions/runs?head_sha=h1&per_page=30`, () => json({ workflow_runs: [ghRun({ status: 'in_progress', conclusion: null })] })),
    ]);
    expect(await gw.documents(repo, { sha: 'h1' })).toEqual({ kind: 'running', runUrl: 'https://github.com/octo/paper/actions/runs/100' });
  });

  it('says none without runs, and empty when the zip holds no PDF', async () => {
    const none = gateway([on('GET', `${R}/actions/runs?head_sha=h1&per_page=30`, () => json({ workflow_runs: [] }))]);
    expect(await none.gw.documents(repo, { sha: 'h1' })).toEqual({ kind: 'none' });

    const empty = gateway([
      on('GET', `${R}/actions/runs?head_sha=h1&per_page=30`, () => json({ workflow_runs: [ghRun()] })),
      on('GET', `${R}/actions/runs/100/artifacts?per_page=100`, () => json({ artifacts: [{ id: 5, name: 'pdf', expired: false, size_in_bytes: 1 }] })),
      on('GET', `${R}/actions/artifacts/5/zip`, () => new Response(zipSync({ 'log.txt': strToU8('x') }))),
    ]);
    expect((await empty.gw.documents(repo, { sha: 'h1' })).kind).toBe('empty');
  });

  it('tries an older run when the newest has no artifact', async () => {
    const { gw } = gateway([
      on('GET', `${R}/actions/runs?head_sha=h1&per_page=30`, () =>
        json({ workflow_runs: [ghRun({ id: 101, created_at: '2026-10-28T11:00:00Z' }), ghRun()] }),
      ),
      on('GET', `${R}/actions/runs/101/artifacts?per_page=100`, () => json({ artifacts: [] })),
      on('GET', `${R}/actions/runs/100/artifacts?per_page=100`, () => json({ artifacts: [{ id: 5, name: 'pdf', expired: false, size_in_bytes: 1 }] })),
      on('GET', `${R}/actions/artifacts/5/zip`, () => new Response(zip)),
    ]);
    expect((await gw.documents(repo, { sha: 'h1' })).kind).toBe('ready');
  });
});
