import type { BlobInfo } from '../domain';

// Repository text for the project index. Keyed by blob SHA, so a new commit
// (a save, a merge from the default branch) re-reads only the files whose
// content changed; without a SHA the key falls back to the commit. Reads run
// at most `limit` at a time, to stay gentle with the GitHub API.

export const READ_CONCURRENCY = 6;

export function createTextCache(read: (path: string, ref: string) => Promise<string>, limit = READ_CONCURRENCY) {
  const cache = new Map<string, Promise<string | undefined>>();
  let active = 0;
  const waiting: (() => void)[] = [];

  const slot = async <T,>(run: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await run();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };

  const get = (path: string, blob: BlobInfo | undefined, ref: string) => {
    const key = blob ? `${path}\u0000${blob.sha}` : `${path}\u0000@${ref}`;
    let p = cache.get(key);
    if (!p) {
      p = slot(() => read(path, ref)).then(
        (text) => text,
        () => {
          // Not remembered, so a later build tries again.
          cache.delete(key);
          return undefined;
        },
      );
      cache.set(key, p);
    }
    return p;
  };

  return {
    texts(paths: readonly string[], blobs: Readonly<Record<string, BlobInfo>>, ref: string) {
      return Promise.all(paths.map(async (path) => ({ path, text: await get(path, blobs[path], ref) })));
    },
  };
}
