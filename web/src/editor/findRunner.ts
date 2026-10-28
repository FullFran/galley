import type { FindOptions, FindResult } from './findAll';

// Runs a search in a worker with a time limit. A JavaScript regular
// expression cannot be interrupted, so a pattern that backtracks for minutes
// (`(a+)+$`) would freeze the page if it ran here; in a worker it is simply
// terminated, and the next search starts a fresh one.

export const FIND_TIMEOUT_MS = 2000;

export interface FindWorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(data: unknown): void;
  terminate(): void;
}

export interface FindRequest {
  id: number;
  files: { path: string; text: string }[];
  options: FindOptions;
}

export interface FindReply {
  id: number;
  result: FindResult;
}

const EMPTY: FindResult = { files: [], total: 0, truncated: false, timedOut: false };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checked inside the worker: anything but this exact shape is ignored. */
export function parseFindRequest(data: unknown): FindRequest | undefined {
  if (!isRecord(data) || typeof data.id !== 'number' || !Array.isArray(data.files) || !isRecord(data.options)) return undefined;
  const o = data.options;
  if (typeof o.query !== 'string' || typeof o.caseSensitive !== 'boolean' || typeof o.wholeWord !== 'boolean' || typeof o.regex !== 'boolean') {
    return undefined;
  }
  const files: FindRequest['files'] = [];
  for (const f of data.files) {
    if (!isRecord(f) || typeof f.path !== 'string' || typeof f.text !== 'string') return undefined;
    files.push({ path: f.path, text: f.text });
  }
  return { id: data.id, files, options: { query: o.query, caseSensitive: o.caseSensitive, wholeWord: o.wholeWord, regex: o.regex } };
}

export function defaultFindWorker(): FindWorkerLike {
  return new Worker(new URL('./findWorker.ts', import.meta.url), { type: 'module', name: 'galley-find' }) as unknown as FindWorkerLike;
}

/** A search function; a newer search or the time limit stops the one before. */
export function createFindRunner(make: () => FindWorkerLike = defaultFindWorker, timeoutMs = FIND_TIMEOUT_MS) {
  let worker: FindWorkerLike | undefined;
  let seq = 0;
  let pending: { id: number; resolve: (r: FindResult) => void; timer: ReturnType<typeof setTimeout> } | undefined;

  const stop = (result: FindResult) => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.resolve(result);
    pending = undefined;
    worker?.terminate();
    worker = undefined;
  };

  return (files: FindRequest['files'], options: FindOptions): Promise<FindResult> => {
    stop(EMPTY);
    return new Promise((resolve) => {
      const id = ++seq;
      const w = (worker ??= make());
      w.onmessage = (event: MessageEvent) => {
        const reply = event.data as FindReply;
        if (!pending || reply?.id !== pending.id) return;
        clearTimeout(pending.timer);
        pending = undefined;
        resolve(reply.result);
      };
      pending = { id, resolve, timer: setTimeout(() => stop({ ...EMPTY, timedOut: true }), timeoutMs) };
      const request: FindRequest = { id, files, options };
      w.postMessage(request);
    });
  };
}
