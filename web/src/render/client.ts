import type { ProjectSource, RenderResult } from './index';

// Runs `render` in a module Web Worker so a slow or hostile document can never
// freeze the editor. The worker reads files through the main thread (the
// GitHub token stays here). Each render has a compute budget; time spent
// waiting for file reads does not count. A render over budget terminates the
// worker, and the next render starts a fresh one.

export type WorkerRequest =
  | { type: 'render'; id: number; files: string[]; entry?: string }
  | { type: 'read-result'; id: number; req: number; ok: true; value: string | Uint8Array }
  | { type: 'read-result'; id: number; req: number; ok: false };

export type WorkerReply =
  | { type: 'read'; id: number; req: number; path: string; binary: boolean }
  | { type: 'done'; id: number; result: RenderResult };

export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null;
}

export const RENDER_BUDGET_MS = 5000;

/** The result of a render that went over budget. */
export const TOO_COMPLEX: RenderResult = {
  html: '',
  assets: [],
  diagnostics: [
    {
      severity: 'error',
      message: `This document is too complex to preview (rendering took more than ${RENDER_BUDGET_MS / 1000} s).`,
    },
  ],
};

function spawnWorker(): WorkerLike {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'galley-render' }) as unknown as WorkerLike;
}

interface Job {
  id: number;
  project: ProjectSource;
  resolve: (result: RenderResult | undefined) => void;
}

/**
 * `render` resolves with the result, or with undefined when a newer render
 * replaced this one before it started. Only one render runs at a time.
 */
export function createRenderClient(spawn: () => WorkerLike = spawnWorker, budgetMs = RENDER_BUDGET_MS) {
  let worker: WorkerLike | undefined;
  let nextId = 0;
  let running: (Job & { remaining: number; startedAt: number; timer?: ReturnType<typeof setTimeout>; reads: number }) | undefined;
  let queued: Job | undefined;

  const pause = () => {
    if (!running?.timer) return;
    clearTimeout(running.timer);
    running.timer = undefined;
    running.remaining -= Date.now() - running.startedAt;
  };
  const resume = () => {
    if (!running || running.timer || running.reads > 0) return;
    running.startedAt = Date.now();
    running.timer = setTimeout(expire, Math.max(0, running.remaining));
  };

  const finish = (result: RenderResult) => {
    const job = running;
    if (!job) return;
    pause();
    running = undefined;
    job.resolve(result);
    const next = queued;
    queued = undefined;
    if (next) start(next);
  };

  function expire() {
    worker?.terminate();
    worker = undefined;
    finish(TOO_COMPLEX);
  }

  function start(job: Job) {
    if (!worker) {
      const w = spawn();
      w.onmessage = (event) => onReply(w, event.data);
      worker = w;
    }
    running = { ...job, remaining: budgetMs, startedAt: Date.now(), reads: 0 };
    resume();
    worker.postMessage({ type: 'render', id: job.id, files: [...job.project.files], entry: job.project.entry });
  }

  function onReply(from: WorkerLike, reply: WorkerReply) {
    const job = running;
    if (from !== worker || !job || reply.id !== job.id) return;
    if (reply.type === 'done') {
      finish(reply.result);
      return;
    }
    job.reads++;
    pause();
    const read = reply.binary ? job.project.readBytes(reply.path) : job.project.readText(reply.path);
    read.then(
      (value) => from.postMessage({ type: 'read-result', id: job.id, req: reply.req, ok: true, value }),
      () => from.postMessage({ type: 'read-result', id: job.id, req: reply.req, ok: false }),
    ).finally(() => {
      if (running !== job) return;
      job.reads--;
      resume();
    });
  }

  return {
    render(project: ProjectSource): Promise<RenderResult | undefined> {
      return new Promise((resolve) => {
        const job = { id: ++nextId, project, resolve };
        if (!running) {
          start(job);
          return;
        }
        queued?.resolve(undefined);
        queued = job;
      });
    },
    dispose() {
      worker?.terminate();
      worker = undefined;
    },
  };
}
