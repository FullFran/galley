// Hash routes. GitHub Pages has no SPA fallback, and the fragment is never
// sent to a server or in a Referer, so repository and file names stay in the
// browser. Parsing is strict: anything unexpected is the repository list.
//
//   #/                                 repositories
//   #/r/{owner}/{repo}                 workspace, main document
//   #/r/{owner}/{repo}/f/{path}        workspace, that file
//   #/r/{owner}/{repo}/proposals[/{n}] proposals, or one proposal
//   #/r/{owner}/{repo}/proposals/by/{login}  proposals by one author
//   #/r/{owner}/{repo}/admin/{tab}     admin area
//   #/r/{owner}/{repo}/history[/compare|since/{base}...{head}]
//                                      versions, or what changed between two
//   #/r/{owner}/{repo}/asks            my asks (review requests with due dates)

import { resolveAdminTab, type AdminTabId } from './adminTabs';

export type Route =
  | { name: 'repos' }
  | { name: 'workspace'; owner: string; repo: string; path?: string }
  | { name: 'proposals'; owner: string; repo: string; number?: number; author?: string }
  | { name: 'admin'; owner: string; repo: string; tab: AdminTabId }
  /** `since`: opened from "What changed since your last visit". */
  | { name: 'history'; owner: string; repo: string; compare?: { base: string; head: string; since: boolean } }
  | { name: 'asks'; owner: string; repo: string };

export type RepoRoute = Exclude<Route, { name: 'repos' }>;

const REPOS: Route = { name: 'repos' };
// GitHub owner and repository names.
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const NUMBER = /^[1-9]\d{0,8}$/;
const RANGE = /^([0-9a-f]{7,40})\.\.\.([0-9a-f]{7,40})$/;
// GitHub logins: alphanumerics and single inner hyphens, at most 39 characters.
export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const RETURN_KEY = 'galley:return-to';

function decode(segment: string): string | undefined {
  try {
    const value = decodeURIComponent(segment);
    // eslint-disable-next-line no-control-regex
    if (value === '' || value === '.' || value === '..' || /[/\\\u0000-\u001f\u007f]/.test(value)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function parseRoute(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw === '' || raw === '/') return REPOS;
  if (!raw.startsWith('/r/')) return REPOS;
  const parts = raw.slice(3).split('/').map(decode);
  if (parts.some((p) => p === undefined)) return REPOS;
  const [owner, repo, section, ...rest] = parts as string[];
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo) || owner === '..' || repo === '..') return REPOS;
  const base = { owner, repo };
  if (section === undefined) return { name: 'workspace', ...base };
  if (section === 'f') return rest.length > 0 ? { name: 'workspace', ...base, path: rest.join('/') } : REPOS;
  if (section === 'proposals') {
    if (rest.length === 0) return { name: 'proposals', ...base };
    if (rest.length === 1 && NUMBER.test(rest[0] ?? '')) return { name: 'proposals', ...base, number: Number(rest[0]) };
    if (rest.length === 2 && rest[0] === 'by' && LOGIN.test(rest[1] ?? '')) return { name: 'proposals', ...base, author: rest[1] };
    return REPOS;
  }
  if (section === 'admin' && rest.length <= 1) return { name: 'admin', ...base, tab: resolveAdminTab(rest[0]) };
  if (section === 'asks' && rest.length === 0) return { name: 'asks', ...base };
  if (section === 'history') {
    if (rest.length === 0) return { name: 'history', ...base };
    const range = rest.length === 2 && (rest[0] === 'compare' || rest[0] === 'since') ? RANGE.exec(rest[1] ?? '') : null;
    if (range?.[1] && range[2]) return { name: 'history', ...base, compare: { base: range[1], head: range[2], since: rest[0] === 'since' } };
  }
  return REPOS;
}

export function formatRoute(route: Route): string {
  if (route.name === 'repos') return '#/';
  const enc = encodeURIComponent;
  const base = `#/r/${enc(route.owner)}/${enc(route.repo)}`;
  switch (route.name) {
    case 'workspace':
      return route.path ? `${base}/f/${route.path.split('/').map(enc).join('/')}` : base;
    case 'proposals':
      if (route.number !== undefined) return `${base}/proposals/${route.number}`;
      return route.author ? `${base}/proposals/by/${enc(route.author)}` : `${base}/proposals`;
    case 'admin':
      return `${base}/admin/${route.tab}`;
    case 'history':
      return route.compare
        ? `${base}/history/${route.compare.since ? 'since' : 'compare'}/${enc(route.compare.base)}...${enc(route.compare.head)}`
        : `${base}/history`;
    case 'asks':
      return `${base}/asks`;
  }
}

export function repoRoute(fullName: string): { owner: string; repo: string } {
  const [owner = '', repo = ''] = fullName.split('/');
  return { owner, repo };
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function session(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/** Kept for the trip through GitHub sign in, which loses the fragment. */
export function rememberRoute(hash: string, store: Store | undefined = session()): void {
  try {
    store?.setItem(RETURN_KEY, hash);
  } catch {
    // Sign in then lands on the repository list.
  }
}

/** The route to go back to after sign in, once; validated like any other hash. */
export function takeRememberedRoute(store: Store | undefined = session()): RepoRoute | undefined {
  try {
    const hash = store?.getItem(RETURN_KEY);
    store?.removeItem(RETURN_KEY);
    if (!hash) return undefined;
    const route = parseRoute(hash);
    return route.name === 'repos' ? undefined : route;
  } catch {
    return undefined;
  }
}
