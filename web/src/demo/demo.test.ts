import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError } from '../domain';
import { createDemo, DEMO_REPO, DEMO_USER } from './gateways';
import { demoRequested, exitDemo } from './mode';

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('demo gateways', () => {
  it('serves the sample paper without any network call', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const demo = createDemo();
    expect(await demo.session.getAccessToken()).toBe('demo');
    expect(await demo.reviews.currentUser()).toEqual(DEMO_USER);
    expect(await demo.gateway.listRepositories()).toEqual([DEMO_REPO]);
    const state = await demo.gateway.openRepository(DEMO_REPO);
    expect(state.branchExists).toBe(false);
    expect(state.files).toEqual(expect.arrayContaining(['index.qmd', 'references.bib', '.galley.yml']));
    const paper = await demo.gateway.readFile(DEMO_REPO, 'index.qmd', state.headSha);
    expect(paper).toContain('# Introduction');
    expect(paper).toContain('$$');
    expect(paper).toContain('@');
    expect(await demo.reviews.listProposals(DEMO_REPO)).toHaveLength(1);
    expect((await demo.comments.listThreads(DEMO_REPO.id)).threads).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('turns a save into a commit and an open proposal with a diff', async () => {
    const demo = createDemo();
    const before = await demo.gateway.openRepository(DEMO_REPO);
    const text = await demo.gateway.readFile(DEMO_REPO, 'index.qmd', before.headSha);
    const saved = await demo.gateway.save(DEMO_REPO, [{ path: 'index.qmd', content: `${text}More toast.\n` }], 'Add more toast\n\nDetails', before.headSha);
    expect(saved.pullRequestUrl).toBe('#/r/galley-demo/toast-paper/proposals/2');
    expect(await demo.gateway.readFile(DEMO_REPO, 'index.qmd', saved.commitSha)).toContain('More toast.');
    expect(await demo.gateway.readFile(DEMO_REPO, 'index.qmd', 'main')).toBe(text);
    const after = await demo.gateway.openRepository(DEMO_REPO);
    expect(after).toMatchObject({ branchExists: true, headSha: saved.commitSha });
    const proposals = await demo.reviews.listProposals(DEMO_REPO);
    expect(proposals.map(p => [p.number, p.title, p.author?.login])).toContainEqual([2, 'Add more toast', DEMO_USER.login]);
    const [changed] = await demo.reviews.listChangedFiles(DEMO_REPO, 2);
    expect(changed).toMatchObject({ path: 'index.qmd', status: 'modified', additions: 1, deletions: 0 });
    expect(changed?.patch).toContain('+More toast.');
    // A second save reuses the same proposal.
    await demo.gateway.save(DEMO_REPO, [{ path: 'index.qmd', content: 'x' }], 'Again', saved.commitSha);
    expect(await demo.reviews.listProposals(DEMO_REPO)).toHaveLength(2);
  });

  it('rejects a save from a stale head and unknown files', async () => {
    const demo = createDemo();
    await expect(demo.gateway.save(DEMO_REPO, [], 'm', 'stale')).rejects.toBeInstanceOf(ConflictError);
    await expect(demo.gateway.readFile(DEMO_REPO, 'missing.qmd', 'main')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('keeps new comment threads and replies in memory', async () => {
    const demo = createDemo();
    const { headSha } = await demo.gateway.openRepository(DEMO_REPO);
    const quote = { exact: 'toast', prefix: '', suffix: '' };
    const thread = await demo.comments.createThread(DEMO_REPO.id, { path: 'index.qmd', commitSha: headSha, startLine: 1, endLine: 1, quote, origin: 'source', body: 'Nice' });
    await demo.comments.reply(thread.id, { body: 'Thanks' });
    await demo.comments.resolve(thread.id);
    const open = await demo.comments.listThreads(DEMO_REPO.id, { status: 'open' });
    expect(open.threads.map(t => t.id)).not.toContain(thread.id);
    const saved = await demo.comments.getThread(thread.id);
    expect(saved.status).toBe('resolved');
    expect(saved.comments.map(c => [c.body, c.mine])).toEqual([['Nice', true], ['Thanks', true]]);
  });
});

describe('demo mode flag', () => {
  it('survives the query string being dropped and can be left', () => {
    expect(demoRequested('')).toBe(false);
    expect(demoRequested('?demo')).toBe(true);
    expect(demoRequested('')).toBe(true);
    exitDemo();
    expect(demoRequested('')).toBe(false);
  });
});
