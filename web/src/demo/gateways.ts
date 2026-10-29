import type { Session } from '../auth/session';
import {
  ConflictError,
  NotFoundError,
  NotTextError,
  type ChangedFile,
  type FileChange,
  type Person,
  type Proposal,
  type RepoGateway,
  type Repository,
  type ReviewComment,
  type ReviewGateway,
  type WorkingState,
} from '../domain';
import type { CommentsGateway, CommentThread, ThreadComment } from '../domain/comments';
import { DEMO_FULL_NAME, exitDemo } from './mode';
import { BUTTER_PARAGRAPH, DEMO_FILES, INDEX_QMD } from './paper';

export const DEMO_REPO: Repository = {
  id: 1,
  owner: 'galley-demo',
  name: 'toast-paper',
  fullName: DEMO_FULL_NAME,
  defaultBranch: 'main',
  private: true,
  updatedAt: '2026-10-28T09:00:00Z',
};
export const DEMO_USER: Person = { login: 'you', id: 0 };
const COAUTHOR: Person = { login: 'ada-crumb', id: 1 };
const WORKING = `galley/${DEMO_USER.login}`;
const COAUTHOR_BRANCH = `galley/${COAUTHOR.login}`;

type Files = Record<string, Uint8Array>;
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new NotTextError('Not a text file'); }
};

/** Stable fake blob SHA, so unchanged files keep their identity across commits. */
function blobSha(bytes: Uint8Array): string {
  let h = 5381;
  for (const b of bytes) h = (h * 33 + b) >>> 0;
  return h.toString(16).padStart(40, '0');
}

/** One hunk around the changed lines: enough for the proposal diff view. */
export function simplePatch(before: string, after: string): { patch: string; additions: number; deletions: number } {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const from = Math.max(0, start - 3);
  const toA = Math.min(a.length, endA + 3);
  const toB = Math.min(b.length, endB + 3);
  const lines = [
    `@@ -${from + 1},${toA - from} +${from + 1},${toB - from} @@`,
    ...a.slice(from, start).map(l => ` ${l}`),
    ...a.slice(start, endA).map(l => `-${l}`),
    ...b.slice(start, endB).map(l => `+${l}`),
    ...a.slice(endA, toA).map(l => ` ${l}`),
  ];
  return { patch: lines.join('\n'), additions: endB - start, deletions: endA - start };
}

const lineOf = (text: string, needle: string) => text.slice(0, text.indexOf(needle)).split('\n').length;

/**
 * In-memory stand-ins for GitHub and galley's API, holding one fictional
 * repository. Nothing leaves the browser; a reload starts the demo over.
 */
export function createDemo() {
  let n = 0;
  const commits = new Map<string, Files>();
  const commit = (files: Files) => {
    const sha = (++n).toString(16).padStart(40, 'd');
    commits.set(sha, files);
    return sha;
  };
  const baseFiles: Files = Object.fromEntries(Object.entries(DEMO_FILES).map(([p, t]) => [p, encode(t)]));
  const base = commit(baseFiles);
  const butter = INDEX_QMD.replace('\n# Results', `${BUTTER_PARAGRAPH}\n# Results`);
  const at = (ref: string): Files => {
    const files = commits.get(branches.get(ref) ?? ref);
    if (!files) throw new NotFoundError(`Unknown ref ${ref}`);
    return files;
  };
  const coauthorHead = commit({ ...baseFiles, 'index.qmd': encode(butter) });
  const branches = new Map<string, string>([['main', base], [COAUTHOR_BRANCH, coauthorHead]]);
  const head = (branch: string) => branches.get(branch) ?? base;
  const now = () => new Date().toISOString();

  const proposals: Proposal[] = [{
    number: 1, title: 'Add a section on butter', author: COAUTHOR, updatedAt: '2026-10-28T09:30:00Z', draft: false,
    body: 'Reviewers asked about butter. One short subsection.', state: 'open',
    headSha: coauthorHead, headBranch: COAUTHOR_BRANCH, sameRepo: true, baseBranch: 'main',
    mergeable: true, mergeableState: 'clean', requestedReviewers: [DEMO_USER], assignees: [],
  }];
  const reviewComments = new Map<number, ReviewComment[]>();
  const proposal = (number: number) => {
    const found = proposals.find(p => p.number === number);
    if (!found) throw new NotFoundError(`No proposal ${number}`);
    return found;
  };
  const write = (branch: string, changes: FileChange[], expected: string) => {
    if (head(branch) !== expected) throw new ConflictError('The branch moved');
    const removed = new Set(changes.filter(c => c.delete).map(c => c.path));
    const files = Object.fromEntries(Object.entries(at(expected)).filter(([path]) => !removed.has(path)));
    for (const c of changes) {
      if (c.delete) continue;
      files[c.path] = c.encoding === 'base64' ? Uint8Array.from(atob(c.content), ch => ch.charCodeAt(0)) : encode(c.content);
    }
    const sha = commit(files);
    branches.set(branch, sha);
    for (const p of proposals) if (p.headBranch === branch && p.state === 'open') Object.assign(p, { headSha: sha, updatedAt: now() });
    return sha;
  };

  const gateway: RepoGateway = {
    async listRepositories() { return [DEMO_REPO]; },
    async openRepository() {
      const headSha = head(WORKING);
      const files = at(headSha);
      const state: WorkingState = {
        branch: WORKING, branchExists: branches.has(WORKING), headSha, files: Object.keys(files), truncated: false,
        blobs: Object.fromEntries(Object.entries(files).map(([p, b]) => [p, { sha: blobSha(b), size: b.length }])),
      };
      return state;
    },
    async readFile(_repo, path, ref) { return decode(await gateway.readBytes(_repo, path, ref)); },
    async readBytes(_repo, path, ref) {
      const bytes = at(ref)[path];
      if (!bytes) throw new NotFoundError(`No file ${path}`);
      return bytes;
    },
    async defaultHead() { return head('main'); },
    async upstream() { return { defaultHead: head('main'), behind: 0 }; },
    async bringInDefault() { return { kind: 'current' }; },
    async save(_repo, changes, message, expectedHeadSha) {
      const commitSha = write(WORKING, changes, expectedHeadSha);
      let mine = proposals.find(p => p.headBranch === WORKING && p.state === 'open');
      if (!mine) {
        const [title = '', ...rest] = message.split('\n');
        mine = {
          number: proposals.length + 1, title, author: DEMO_USER, updatedAt: now(), draft: false, body: rest.join('\n').trim(),
          state: 'open', headSha: commitSha, headBranch: WORKING, sameRepo: true, baseBranch: 'main',
          mergeable: true, mergeableState: 'clean', requestedReviewers: [], assignees: [],
        };
        proposals.push(mine);
      }
      return { commitSha, pullRequestUrl: `#/r/${DEMO_REPO.fullName}/proposals/${mine.number}` };
    },
  };

  const reviews: ReviewGateway = {
    async currentUser() { return DEMO_USER; },
    async listProposals() {
      return proposals.filter(p => p.state === 'open').map(({ number, title, author, updatedAt, draft }) => ({ number, title, author, updatedAt, draft }));
    },
    async getProposal(_repo, number) { return { ...proposal(number) }; },
    async listChangedFiles(_repo, number) {
      const p = proposal(number);
      const before = at(p.baseBranch);
      const after = at(p.headSha);
      const changed: ChangedFile[] = [];
      for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const a = before[path] ? decode(before[path]) : '';
        const b = after[path] ? decode(after[path]) : '';
        if (a === b) continue;
        const status = !before[path] ? 'added' : !after[path] ? 'removed' : 'modified';
        changed.push({ path, status, ...simplePatch(a, b) });
      }
      return changed;
    },
    async listReviewComments(_repo, number) { return reviewComments.get(number) ?? []; },
    async listReviews() { return []; },
    async listReviewThreads() { return []; },
    async setThreadResolved(_repo, id, resolved) { return { id, rootCommentId: 0, resolved, canResolve: true, canUnresolve: true }; },
    async listFiles(_repo, ref) { return { files: Object.keys(at(ref)), truncated: false }; },
    async addComment(_repo, number, _commitId, c) {
      const comment: ReviewComment = {
        id: Date.now(), author: DEMO_USER, body: c.body, path: c.path, line: c.line, startLine: c.startLine ?? null,
        side: c.side, diffHunk: '', subjectType: 'line', createdAt: now(),
      };
      reviewComments.set(number, [...(reviewComments.get(number) ?? []), comment]);
      return comment;
    },
    async reply(_repo, number, rootCommentId, body) {
      const root = (reviewComments.get(number) ?? []).find(c => c.id === rootCommentId);
      if (!root) throw new NotFoundError('No comment');
      const comment = { ...root, id: Date.now(), inReplyToId: rootCommentId, body, author: DEMO_USER, createdAt: now() };
      reviewComments.set(number, [...(reviewComments.get(number) ?? []), comment]);
      return comment;
    },
    async submitReview() { /* Reviews are not kept in the demo. */ },
    async access() { return { canPush: true, admin: false, mergeMethods: ['squash'] }; },
    async listCandidates() { return [COAUTHOR]; },
    async requestReviewers(_repo, number, logins) { proposal(number).requestedReviewers.push(...logins.map(login => login === COAUTHOR.login ? COAUTHOR : DEMO_USER)); },
    async removeReviewers(_repo, number, logins) { const p = proposal(number); p.requestedReviewers = p.requestedReviewers.filter(r => !logins.includes(r.login)); },
    async addAssignees(_repo, number, logins) { proposal(number).assignees.push(...logins.map(login => login === COAUTHOR.login ? COAUTHOR : DEMO_USER)); },
    async removeAssignees(_repo, number, logins) { const p = proposal(number); p.assignees = p.assignees.filter(r => !logins.includes(r.login)); },
    async merge(_repo, number) {
      const p = proposal(number);
      branches.set('main', p.headSha);
      Object.assign(p, { state: 'merged', updatedAt: now() });
    },
    async commitToProposal(_repo, p, changes, _message, expectedHeadSha) { return write(p.headBranch, changes, expectedHeadSha); },
  };

  const quote = 'nobody asked when to';
  const line = lineOf(INDEX_QMD, quote);
  const threads: CommentThread[] = [{
    id: 'demo-thread-1', repoId: DEMO_REPO.id, repoFullName: DEMO_REPO.fullName, status: 'open', origin: 'source',
    anchor: { path: 'index.qmd', commitSha: base, startLine: line, endLine: line, quote: { exact: quote, prefix: 'but ', suffix: '\nstop' } },
    position: { commitSha: base, startLine: line, endLine: line, state: 'exact' },
    createdBy: COAUTHOR.login, createdAt: '2026-10-28T10:00:00Z', updatedAt: '2026-10-28T10:00:00Z',
    comments: [{
      id: 'demo-comment-1', threadId: 'demo-thread-1', author: { kind: 'human', login: COAUTHOR.login }, mine: false,
      body: 'Is two minutes also right for rye bread?', createdAt: '2026-10-28T10:00:00Z',
    }],
  }];
  let ids = 1;
  const thread = (id: string) => {
    const found = threads.find(t => t.id === id);
    if (!found) throw new NotFoundError(`No thread ${id}`);
    return found;
  };
  const mine = (threadId: string, body: string): ThreadComment => ({
    id: `demo-comment-${++ids}`, threadId, author: { kind: 'human', login: DEMO_USER.login }, mine: true, body, createdAt: now(),
  });
  const commentById = (id: string) => {
    for (const t of threads) {
      const c = t.comments.find(x => x.id === id);
      if (c) return { t, c };
    }
    throw new NotFoundError(`No comment ${id}`);
  };
  const setStatus = (id: string, status: 'open' | 'resolved') => {
    const t = thread(id);
    Object.assign(t, { status, updatedAt: now() }, status === 'resolved' ? { resolvedBy: DEMO_USER.login, resolvedAt: now() } : { resolvedBy: undefined, resolvedAt: undefined });
    return structuredClone(t);
  };

  const comments: CommentsGateway = {
    async listThreads(_repoId, filter = {}) {
      const list = threads.filter(t => (!filter.path || t.anchor.path === filter.path) && (!filter.status || t.status === filter.status));
      return { threads: structuredClone(list), truncated: false };
    },
    async createThread(_repoId, input) {
      const { path, commitSha, startLine, endLine, startColumn, endColumn, quote, origin, body } = input;
      const anchor = { path, commitSha, startLine, endLine, startColumn, endColumn, quote };
      const id = `demo-thread-${threads.length + 1}`;
      const created: CommentThread = {
        id, repoId: DEMO_REPO.id, repoFullName: DEMO_REPO.fullName, status: 'open', origin, anchor,
        position: { commitSha: anchor.commitSha, startLine: anchor.startLine, endLine: anchor.endLine, startColumn: anchor.startColumn, endColumn: anchor.endColumn, state: 'exact' },
        createdBy: DEMO_USER.login, createdAt: now(), updatedAt: now(), comments: [mine(id, body)],
      };
      threads.push(created);
      return structuredClone(created);
    },
    async getThread(id) { return structuredClone(thread(id)); },
    async reply(threadId, input) {
      const c = mine(threadId, input.body);
      const t = thread(threadId);
      t.comments.push(c);
      t.updatedAt = c.createdAt;
      return { ...c };
    },
    async editComment(id, input) {
      const { c } = commentById(id);
      Object.assign(c, { body: input.body, editedAt: now() });
      return { ...c };
    },
    async deleteComment(id) {
      const { t, c } = commentById(id);
      t.comments = t.comments.filter(x => x !== c);
    },
    async resolve(id) { return setStatus(id, 'resolved'); },
    async reopen(id) { return setStatus(id, 'open'); },
    async markRead() { /* Nothing is unread in the demo. */ },
    async unread() { return { threads: 0, comments: 0, byThread: {} }; },
  };

  const session: Session = {
    async getAccessToken() { return 'demo'; },
    invalidate() { /* No token to drop. */ },
    loginUrl() { return location.pathname; },
    async logout() { exitDemo(); },
  };

  return { session, gateway, reviews, comments };
}
