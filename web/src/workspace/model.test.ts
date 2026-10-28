import { describe, expect, it } from 'vitest';
import {
  AuthRequiredError,
  ConflictError,
  NotTextError,
  TransientError,
  type FileChange,
  type RepoGateway,
  type Repository,
  type SaveResult,
} from '../domain';
import { applySaved, defaultMessage, describeError, dirtyPaths, runSave, type Buffers } from './model';

const repo: Repository = {
  id: 1,
  owner: 'o',
  name: 'paper',
  fullName: 'o/paper',
  defaultBranch: 'main',
  private: true,
};

function fakeGateway(save: (changes: FileChange[], message: string, head: string) => Promise<SaveResult>) {
  const calls: { changes: FileChange[]; message: string; head: string }[] = [];
  const gateway: RepoGateway = {
    listRepositories: () => Promise.resolve([]),
    openRepository: () => Promise.reject(new Error('unused')),
    readFile: () => Promise.reject(new Error('unused')),
    readBytes: () => Promise.reject(new Error('unused')),
    save: (_repo, changes, message, head) => {
      calls.push({ changes, message, head });
      return save(changes, message, head);
    },
  };
  return { gateway, calls };
}

const buffers: Buffers = {
  'a.qmd': { base: 'old a', text: 'new a' },
  'b.md': { base: 'same', text: 'same' },
  'refs/c.bib': { base: 'old c', text: 'new c' },
};

describe('dirtyPaths and defaultMessage', () => {
  it('lists only edited files', () => {
    expect(dirtyPaths(buffers)).toEqual(['a.qmd', 'refs/c.bib']);
  });

  it('names the edited files by their base name', () => {
    expect(defaultMessage(['a.qmd', 'refs/c.bib'])).toBe('Update a.qmd, c.bib');
    expect(defaultMessage(['a', 'b', 'c', 'd', 'e'])).toBe('Update a, b, c and 2 more files');
  });
});

describe('runSave', () => {
  it('sends only edited files with the head SHA and returns the new head', async () => {
    const { gateway, calls } = fakeGateway(() =>
      Promise.resolve({ commitSha: 'new-sha', pullRequestUrl: 'https://github.com/o/paper/pull/3' }),
    );
    const outcome = await runSave(gateway, repo, buffers, 'Fix typo', 'old-sha');
    expect(calls).toEqual([
      {
        changes: [
          { path: 'a.qmd', content: 'new a' },
          { path: 'refs/c.bib', content: 'new c' },
        ],
        message: 'Fix typo',
        head: 'old-sha',
      },
    ]);
    expect(outcome).toEqual({
      kind: 'saved',
      headSha: 'new-sha',
      pullRequestUrl: 'https://github.com/o/paper/pull/3',
      saved: calls[0]?.changes,
    });
  });

  it('clears dirty state for the saved content only', async () => {
    const { gateway } = fakeGateway(() => Promise.resolve({ commitSha: 'new-sha' }));
    const outcome = await runSave(gateway, repo, buffers, 'm', 'old-sha');
    if (outcome.kind !== 'saved') throw new Error(`unexpected ${outcome.kind}`);
    expect(dirtyPaths(applySaved(buffers, outcome.saved))).toEqual([]);
    // Typing that happened while the save was in flight stays unsaved.
    const typedMeanwhile = { ...buffers, 'a.qmd': { base: 'old a', text: 'newer a' } };
    expect(dirtyPaths(applySaved(typedMeanwhile, outcome.saved))).toEqual(['a.qmd']);
  });

  it('keeps a copy of the user text on a conflict', async () => {
    const { gateway } = fakeGateway(() => Promise.reject(new ConflictError('moved')));
    expect(await runSave(gateway, repo, buffers, 'm', 'old-sha')).toEqual({
      kind: 'conflict',
      copies: [
        { path: 'a.qmd', content: 'new a' },
        { path: 'refs/c.bib', content: 'new c' },
      ],
    });
  });

  it('reports a lost session as auth', async () => {
    const { gateway } = fakeGateway(() => Promise.reject(new AuthRequiredError('gone')));
    expect(await runSave(gateway, repo, buffers, 'm', 'old-sha')).toEqual({ kind: 'auth' });
  });

  it('reports transient failures with a retry hint', async () => {
    const { gateway } = fakeGateway(() => Promise.reject(new TransientError('503')));
    const outcome = await runSave(gateway, repo, buffers, 'm', 'old-sha');
    expect(outcome.kind).toBe('error');
    expect(outcome.kind === 'error' && outcome.message).toMatch(/try again/i);
  });
});

describe('describeError', () => {
  it('explains files that cannot be edited', () => {
    expect(describeError(new NotTextError('binary'))).toMatch(/cannot be edited here/);
  });
});
