import type { IndexInput, ProjectIndex } from './projectIndex';

// Builds the project index (BibTeX parsing and label scanning over every file)
// in a small module worker, so a large bibliography never blocks typing. The
// BibTeX parser then lives in the worker's chunk, not the initial bundle.

export interface IndexRequest {
  id: number;
  input: IndexInput;
}

export interface IndexReply {
  id: number;
  index: ProjectIndex;
}

export interface IndexWorkerLike {
  postMessage(message: IndexRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<IndexReply>) => void) | null;
}

function spawnIndexWorker(): IndexWorkerLike {
  return new Worker(new URL('./indexWorker.ts', import.meta.url), { type: 'module', name: 'galley-index' }) as unknown as IndexWorkerLike;
}

/** `build` resolves with the index, or undefined when a newer build replaced it. */
export function createIndexer(spawn: () => IndexWorkerLike = spawnIndexWorker) {
  let worker: IndexWorkerLike | undefined;
  let nextId = 0;
  const pending = new Map<number, (index: ProjectIndex | undefined) => void>();

  const onReply = (event: MessageEvent<IndexReply>) => {
    const { id, index } = event.data;
    for (const [waiting, resolve] of pending) {
      if (waiting > id) continue;
      pending.delete(waiting);
      resolve(waiting === id ? index : undefined);
    }
  };

  return {
    build(input: IndexInput): Promise<ProjectIndex | undefined> {
      if (!worker) {
        worker = spawn();
        worker.onmessage = onReply;
      }
      const id = ++nextId;
      // Only the newest build matters.
      for (const [waiting, resolve] of pending) {
        pending.delete(waiting);
        resolve(undefined);
      }
      return new Promise((resolve) => {
        pending.set(id, resolve);
        worker?.postMessage({ id, input });
      });
    },
    dispose() {
      worker?.terminate();
      worker = undefined;
      for (const resolve of pending.values()) resolve(undefined);
      pending.clear();
    },
  };
}
