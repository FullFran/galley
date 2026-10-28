import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute, rememberRoute, takeRememberedRoute, type Route } from './route';

const memory = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
};

describe('hash routes', () => {
  const routes: [string, Route][] = [
    ['#/', { name: 'repos' }],
    ['#/r/o/paper', { name: 'workspace', owner: 'o', repo: 'paper' }],
    ['#/r/o/paper/f/index.qmd', { name: 'workspace', owner: 'o', repo: 'paper', path: 'index.qmd' }],
    ['#/r/o/paper/f/sections/02-model.qmd', { name: 'workspace', owner: 'o', repo: 'paper', path: 'sections/02-model.qmd' }],
    ['#/r/o/paper/f/my%20notes/caf%C3%A9.md', { name: 'workspace', owner: 'o', repo: 'paper', path: 'my notes/café.md' }],
    ['#/r/o/paper/proposals', { name: 'proposals', owner: 'o', repo: 'paper' }],
    ['#/r/o/paper/proposals/4', { name: 'proposals', owner: 'o', repo: 'paper', number: 4 }],
    ['#/r/o/paper/admin/settings', { name: 'admin', owner: 'o', repo: 'paper', tab: 'settings' }],
    ['#/r/o/paper/admin/view-as', { name: 'admin', owner: 'o', repo: 'paper', tab: 'view-as' }],
    ['#/r/o/paper/admin/shared', { name: 'admin', owner: 'o', repo: 'paper', tab: 'shared' }],
    ['#/r/o/paper/proposals/by/ana-b', { name: 'proposals', owner: 'o', repo: 'paper', author: 'ana-b' }],
    ['#/r/Org-1/my.repo_2', { name: 'workspace', owner: 'Org-1', repo: 'my.repo_2' }],
    ['#/r/o/paper/history', { name: 'history', owner: 'o', repo: 'paper' }],
    ['#/r/o/paper/asks', { name: 'asks', owner: 'o', repo: 'paper' }],
    ['#/r/o/paper/history/compare/abc1234...def5678', { name: 'history', owner: 'o', repo: 'paper', compare: { base: 'abc1234', head: 'def5678', since: false } }],
    ['#/r/o/paper/history/since/abc1234...def5678', { name: 'history', owner: 'o', repo: 'paper', compare: { base: 'abc1234', head: 'def5678', since: true } }],
  ];

  it.each(routes)('parses and formats %s', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
    expect(formatRoute(route)).toBe(hash);
    expect(parseRoute(formatRoute(route))).toEqual(route);
  });

  it('treats empty and bare hashes as the repository list', () => {
    expect(parseRoute('')).toEqual({ name: 'repos' });
    expect(parseRoute('#')).toEqual({ name: 'repos' });
  });

  it('resolves a missing or unknown admin tab to the default', () => {
    expect(parseRoute('#/r/o/paper/admin')).toEqual({ name: 'admin', owner: 'o', repo: 'paper', tab: 'settings' });
    expect(parseRoute('#/r/o/paper/admin/nope')).toEqual({ name: 'admin', owner: 'o', repo: 'paper', tab: 'settings' });
  });

  it.each([
    '#/unknown',
    '#r/o/paper',
    '#/r/o',
    '#/r//paper',
    '#/r/o/paper/zzz',
    '#/r/o/paper/history/compare/abc1234',
    '#/r/o/paper/history/compare/zzzzzzz...abc1234',
    '#/r/o/paper/history/other/abc1234...def5678',
    '#/r/o/paper/history/compare/abc1234...def5678/x',
    '#/r/../paper',
    '#/r/o/%2e%2e',
    '#/r/o/paper/f/../secret',
    '#/r/o/paper/f/a/%2e%2e/b',
    '#/r/o/paper/f/a%2fb',
    '#/r/o/paper/f/a%5cb',
    '#/r/o/paper/f/a//b',
    '#/r/o/paper/f/',
    '#/r/o/paper/f/%E0%A4%A',
    '#/r/o/paper/f/a%00b',
    '#/r/o p/paper',
    '#/r/o/<script>',
    '#/r/o/paper/proposals/0',
    '#/r/o/paper/proposals/-1',
    '#/r/o/paper/proposals/4x',
    '#/r/o/paper/proposals/99999999999',
    '#/r/o/paper/proposals/4/extra',
    '#/r/o/paper/proposals/by',
    '#/r/o/paper/proposals/by/-ana',
    '#/r/o/paper/proposals/by/a%20b',
    '#/r/o/paper/proposals/by/ana/x',
    '#/r/o/paper/admin/settings/extra',
    'javascript:alert(1)',
  ])('rejects %s and falls back to the repository list', (hash) => {
    expect(parseRoute(hash)).toEqual({ name: 'repos' });
  });

  it('encodes every segment when formatting', () => {
    expect(formatRoute({ name: 'workspace', owner: 'o', repo: 'paper', path: 'a b/#c?.md' })).toBe('#/r/o/paper/f/a%20b/%23c%3F.md');
  });
});

describe('return to the route after sign in', () => {
  it('remembers a route once and validates it on the way back', () => {
    const store = memory();
    rememberRoute('#/r/o/paper/proposals/4', store);
    expect(takeRememberedRoute(store)).toEqual({ name: 'proposals', owner: 'o', repo: 'paper', number: 4 });
    expect(takeRememberedRoute(store)).toBeUndefined();
  });

  it('drops invalid remembered routes and the plain repository list', () => {
    const store = memory();
    store.setItem('galley:return-to', '#/r/o/../x');
    expect(takeRememberedRoute(store)).toBeUndefined();
    rememberRoute('#/', store);
    expect(takeRememberedRoute(store)).toBeUndefined();
  });

  it('tolerates blocked storage', () => {
    const broken = {
      getItem: () => {
        throw new Error('x');
      },
      setItem: () => {
        throw new Error('x');
      },
      removeItem: () => {
        throw new Error('x');
      },
    };
    expect(() => rememberRoute('#/r/o/p', broken)).not.toThrow();
    expect(takeRememberedRoute(broken)).toBeUndefined();
  });
});
