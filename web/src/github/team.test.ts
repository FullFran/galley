import { describe, expect, it, vi } from 'vitest';
import type { Repository } from '../domain';
import { fakeFetch, json, on, type Route } from '../test/fakeFetch';
import { createGitHubTeamGateway } from './team';

const GH = 'https://api.github.com';
const R = `${GH}/repos/octo/paper`;
const repo: Repository = { id: 7, owner: 'octo', name: 'paper', fullName: 'octo/paper', defaultBranch: 'main', private: true };

function gateway(routes: Route[]) {
  const tokens = { getAccessToken: vi.fn(async () => 'tok'), invalidate: vi.fn() };
  const fake = fakeFetch(routes);
  return { gw: createGitHubTeamGateway({ tokens, fetch: fake.fetch, now: () => new Date('2026-10-28T10:00:00Z') }), ...fake, tokens };
}

const askInput = {
  what: 'Methods',
  galleyUrl: 'https://galley.example/#/r/octo/paper',
  assignee: 'ben',
  due: '2026-10-30',
};
const created = () => json({ number: 12, html_url: `https://github.com/octo/paper/issues/12` }, 201);

describe('GitHub team gateway: asks', () => {
  it('creates the label and the milestone when missing, then the issue with assignee and milestone', async () => {
    const { gw, requests, tokens } = gateway([
      on('GET', `${R}/labels/galley-ask`, () => json({ message: 'Not Found' }, 404)),
      on('POST', `${R}/labels`, () => json({ name: 'galley-ask' }, 201)),
      on('GET', `${R}/milestones?state=all&per_page=100`, () => json([{ number: 1, title: 'Due 2026-11-30' }])),
      on('POST', `${R}/milestones`, () => json({ number: 5, title: 'Due 2026-10-30' }, 201)),
      on('POST', `${R}/issues`, created),
    ]);
    const ask = await gw.createAsk(repo, askInput);
    expect(ask).toEqual({ number: 12, url: 'https://github.com/octo/paper/issues/12' });
    const posts = requests.filter((r) => r.method === 'POST');
    expect(posts[0]?.body).toMatchObject({ name: 'galley-ask' });
    expect(posts[1]?.body).toEqual({ title: 'Due 2026-10-30', due_on: '2026-10-30T12:00:00Z' });
    expect(posts[2]?.body).toMatchObject({ title: 'Review: Methods', labels: ['galley-ask'], assignees: ['ben'], milestone: 5 });
    expect(tokens.getAccessToken).toHaveBeenCalledWith();
  });

  it('reuses an existing label and milestone', async () => {
    const { gw, requests } = gateway([
      on('GET', `${R}/labels/galley-ask`, () => json({ name: 'galley-ask' })),
      on('GET', `${R}/milestones?state=all&per_page=100`, () => json([{ number: 4, title: 'Due 2026-10-30' }])),
      on('POST', `${R}/issues`, created),
    ]);
    await gw.createAsk(repo, askInput);
    const posts = requests.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({ milestone: 4 });
  });

  it('survives a label created at the same time by someone else (422)', async () => {
    const { gw } = gateway([
      on('GET', `${R}/labels/galley-ask`, () => json({}, 404)),
      on('POST', `${R}/labels`, () => json({ message: 'Validation Failed' }, 422)),
      on('GET', `${R}/milestones?state=all&per_page=100`, () => json([{ number: 4, title: 'Due 2026-10-30' }])),
      on('POST', `${R}/issues`, created),
    ]);
    await expect(gw.createAsk(repo, askInput)).resolves.toMatchObject({ number: 12 });
  });

  it('refuses a bad date or login before calling GitHub', async () => {
    const { gw, requests } = gateway([]);
    await expect(gw.createAsk(repo, { ...askInput, due: 'friday' })).rejects.toThrow();
    await expect(gw.createAsk(repo, { ...askInput, assignee: 'bad login' })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it('lists my asks: open galley-ask issues assigned to me or created by me', async () => {
    const issue = (n: number) => ({ number: n, title: `Review: ${n}`, html_url: `u${n}`, state: 'open', user: { login: 'ana' }, assignees: [{ login: 'ben' }], comments: 0, milestone: null });
    const { gw } = gateway([
      on('GET', `${R}/issues?labels=galley-ask&state=open&assignee=ben&per_page=100`, () => json([issue(1)])),
      on('GET', `${R}/issues?labels=galley-ask&state=open&creator=ben&per_page=100`, () => json([issue(1), issue(2)])),
    ]);
    expect((await gw.myAsks(repo, 'ben')).map((a) => a.number)).toEqual([1, 2]);
  });

  it('lists assignable people', async () => {
    const { gw } = gateway([on('GET', `${R}/assignees?per_page=100`, () => json([{ login: 'ana' }, { login: 'ben' }]))]);
    expect(await gw.assignees(repo)).toEqual(['ana', 'ben']);
  });

  it('closes an ask as completed', async () => {
    const { gw, requests } = gateway([on('PATCH', `${R}/issues/12`, () => json({ number: 12 }))]);
    await gw.closeAsk(repo, 12);
    expect(requests[0]?.body).toEqual({ state: 'closed', state_reason: 'completed' });
  });
});

describe('GitHub team gateway: weekly activity', () => {
  it('reads galley branches and the default branch, proposals, reviews and comments of the last 7 days', async () => {
    const since = '2026-10-21T10:00:00.000Z';
    const commit = (sha: string, login: string) => ({ sha, author: { login }, commit: { author: { name: login, date: '2026-10-25T00:00:00Z' } } });
    const { gw } = gateway([
      on('GET', `${R}/branches?per_page=100`, () => json([{ name: 'main' }, { name: 'galley/ana' }, { name: 'feature' }])),
      on('GET', `${R}/commits?sha=main&since=${encodeURIComponent(since)}&per_page=100`, () => json([commit('a', 'ana')])),
      on('GET', `${R}/commits?sha=galley%2Fana&since=${encodeURIComponent(since)}&per_page=100`, () => json([commit('a', 'ana'), commit('b', 'ana')])),
      on('GET', `${R}/pulls?state=all&sort=updated&direction=desc&per_page=100`, () =>
        json([
          { number: 4, user: { login: 'ana' }, created_at: '2026-10-22T00:00:00Z', merged_at: null, updated_at: '2026-10-25T00:00:00Z' },
          { number: 3, user: { login: 'ben' }, created_at: '2026-01-01T00:00:00Z', merged_at: null, updated_at: '2026-01-02T00:00:00Z' },
        ]),
      ),
      on('GET', `${R}/pulls/4/reviews?per_page=100`, () => json([{ user: { login: 'ben' }, submitted_at: '2026-10-23T00:00:00Z', state: 'APPROVED' }])),
      on('GET', `${R}/pulls/comments?since=${encodeURIComponent(since)}&per_page=100`, () => json([{ id: 1, user: { login: 'ben' }, created_at: '2026-10-23T00:00:00Z' }])),
      on('GET', `${R}/issues/comments?since=${encodeURIComponent(since)}&per_page=100`, () => json([{ id: 2, user: { login: 'cleo' }, created_at: '2026-10-24T00:00:00Z' }])),
    ]);
    const { rows } = await gw.activity(repo);
    expect(rows).toEqual([
      { login: 'ana', commits: 2, opened: 1, merged: 0, reviews: 0, comments: 0 },
      { login: 'ben', commits: 0, opened: 0, merged: 0, reviews: 1, comments: 1 },
      { login: 'cleo', commits: 0, opened: 0, merged: 0, reviews: 0, comments: 1 },
    ]);
  });
});
