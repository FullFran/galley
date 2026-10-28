import { render, type ProjectSource } from './index';
import type { WorkerReply, WorkerRequest } from './client';

// The render worker. It runs only galley's renderer (repository content is
// parsed into strings, never executed) and asks the main thread, which owns
// the repository access, for every file it needs.

interface WorkerScope {
  postMessage(message: WorkerReply): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const pending = new Map<number, { resolve: (v: string | Uint8Array) => void; reject: (e: Error) => void }>();
let nextReq = 0;

function read(id: number, path: string, binary: boolean): Promise<string | Uint8Array> {
  return new Promise((resolve, reject) => {
    const req = ++nextReq;
    pending.set(req, { resolve, reject });
    scope.postMessage({ type: 'read', id, req, path, binary });
  });
}

scope.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'read-result') {
    const p = pending.get(msg.req);
    pending.delete(msg.req);
    if (!p) return;
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error('read failed'));
    return;
  }
  const project: ProjectSource = {
    files: msg.files,
    readText: async (path) => {
      const v = await read(msg.id, path, false);
      if (typeof v !== 'string') throw new Error(`${path} is not text`);
      return v;
    },
    readBytes: async (path) => {
      const v = await read(msg.id, path, true);
      if (!(v instanceof Uint8Array)) throw new Error(`${path} is not binary`);
      return v;
    },
  };
  void render(project).then((result) => scope.postMessage({ type: 'done', id: msg.id, result }));
};
