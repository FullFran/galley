import type { Diagnostic, ProjectSource } from '../render';
import { renderLatex as defaultRenderLatex, type LatexResult } from '../render/latex';

export const COMPILE_BUDGET_MS = 60_000;

export interface CompileResult {
  pdf?: Blob;
  notes: Diagnostic[];
  durationMs: number;
}

export type TexWorkerRequest =
  | {
      busytex_js: string;
      busytex_wasm: string;
      preload_data_packages_js: string[];
      data_packages_js: string[];
      texmf_local: unknown[];
      preload: boolean;
    }
  | {
      files: { path: string; contents: string | Uint8Array }[];
      main_tex_path: string;
      bibtex: boolean;
      verbose: string;
      driver: string;
      data_packages_js: string[];
    };

export type TexWorkerReply =
  | { initialized: unknown }
  | { print: string }
  | { exit_code: number; pdf?: Uint8Array | null; log?: string; logs?: unknown[] }
  | { exception: string };

export interface WorkerLike {
  postMessage(message: TexWorkerRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<TexWorkerReply>) => void) | null;
  onerror?: ((event: Event) => void) | null;
}

export interface CompileClientOptions {
  budgetMs?: number;
  base?: string;
  renderLatex?: (project: ProjectSource) => Promise<LatexResult>;
  now?: () => number;
}

export interface CompileClient {
  compile(project: ProjectSource): Promise<CompileResult | undefined>;
  dispose(): void;
}

function spawnTexWorker(base = import.meta.env.BASE_URL || '/'): WorkerLike {
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return new Worker(`${prefix}tex/busytex_worker.js`) as unknown as WorkerLike;
}

/** Parses TeX logs to extract the first error and its source line. */
export function parseTexLog(log: string, exitCode = 1): Diagnostic[] {
  // Find the first line starting with '! '
  const errMatch = log.match(/^!\s+(.+)$/m);
  if (!errMatch) {
    return [
      {
        severity: 'error',
        message: `LaTeX compilation failed with exit code ${exitCode}.`,
        path: 'index.tex',
      },
    ];
  }

  const errLine = errMatch[0];
  const afterErr = log.slice((errMatch.index ?? 0) + errMatch[0].length);
  const lineMatch = afterErr.match(/[\r\n]l\.(\d+)(?:\s+(.*))?/);

  let message = errLine;

  if (lineMatch) {
    const lLine = lineMatch[0].trim();
    message = `${errLine}\n${lLine}`;
  }

  return [
    {
      severity: 'error',
      message,
      path: 'index.tex',
    },
  ];
}

interface Job {
  id: number;
  project: ProjectSource;
  resolve: (result: CompileResult | undefined) => void;
}

/**
 * Creates a client for the in-browser BusyTeX compile worker.
 * Spawns one long-lived worker lazily on first use, initialises once,
 * and processes compilation jobs sequentially with a 60-second budget.
 */
export function createCompileClient(
  spawn: () => WorkerLike = spawnTexWorker,
  options?: CompileClientOptions,
): CompileClient {
  const budgetMs = options?.budgetMs ?? COMPILE_BUDGET_MS;
  const base = options?.base ?? import.meta.env.BASE_URL ?? '/';
  const prefix = base.endsWith('/') ? base : `${base}/`;
  const renderLatex = options?.renderLatex ?? defaultRenderLatex;
  const now = options?.now ?? Date.now;

  let worker: WorkerLike | undefined;
  let initialized = false;
  let initializing = false;
  let initWaiters: { resolve: () => void; reject: (err: unknown) => void }[] = [];

  let nextId = 0;
  let running:
    | (Job & {
        startedAt: number;
        timer?: ReturnType<typeof setTimeout>;
        latexDiagnostics: Diagnostic[];
      })
    | undefined;
  let queued: Job | undefined;
  let disposed = false;

  function ensureWorker(): WorkerLike {
    if (!worker) {
      const w = spawn();
      w.onmessage = (event) => onMessage(w, event.data);
      if ('onerror' in w) {
        w.onerror = (err) => onError(w, err);
      }
      worker = w;
      initialized = false;
      initializing = false;
    }
    return worker;
  }

  function terminateWorker() {
    if (worker) {
      try {
        worker.terminate();
      } catch {
        // Ignore termination errors
      }
      worker = undefined;
    }
    initialized = false;
    initializing = false;
    const waiters = initWaiters;
    initWaiters = [];
    for (const w of waiters) {
      w.reject(new Error('Worker terminated'));
    }
  }

  function initWorker(): Promise<void> {
    if (initialized) return Promise.resolve();
    if (initializing) {
      return new Promise<void>((resolve, reject) => {
        initWaiters.push({ resolve, reject });
      });
    }

    initializing = true;
    const w = ensureWorker();

    return new Promise<void>((resolve, reject) => {
      initWaiters.push({ resolve, reject });
      w.postMessage({
        busytex_js: `${prefix}tex/busytex.js`,
        busytex_wasm: `${prefix}tex/busytex.wasm`,
        preload_data_packages_js: [`${prefix}tex/galley-tex.js`],
        data_packages_js: [`${prefix}tex/galley-tex.js`],
        texmf_local: [],
        preload: true,
      });
    });
  }

  function onInitSuccess() {
    initialized = true;
    initializing = false;
    const waiters = initWaiters;
    initWaiters = [];
    for (const w of waiters) {
      w.resolve();
    }
  }

  function onInitFailure(err: unknown) {
    terminateWorker();
    const waiters = initWaiters;
    initWaiters = [];
    for (const w of waiters) {
      w.reject(err);
    }
  }

  function onError(from: WorkerLike, err: unknown) {
    if (from !== worker) return;
    if (initializing) {
      onInitFailure(err);
    }
    if (running) {
      const durationMs = now() - running.startedAt;
      const notes: Diagnostic[] = [
        {
          severity: 'error',
          message: 'Draft PDF engine assets are missing or failed to load. Run `npm run tex:build` to build them.',
        },
      ];
      terminateWorker();
      finish({ pdf: undefined, notes, durationMs });
    }
  }

  function onMessage(from: WorkerLike, data: TexWorkerReply) {
    if (from !== worker) return;
    if (!data || typeof data !== 'object') return;

    if ('initialized' in data) {
      onInitSuccess();
      return;
    }

    if ('exception' in data) {
      const isMissingAsset =
        initializing ||
        /fetch|404|importScripts|Failed to load|asset|package/i.test(String(data.exception));
      const message = isMissingAsset
        ? 'Draft PDF engine assets are missing or failed to load. Run `npm run tex:build` to build them.'
        : `TeX engine error: ${String(data.exception)}`;

      if (initializing) {
        onInitFailure(new Error(message));
      }
      if (running) {
        const durationMs = now() - running.startedAt;
        terminateWorker();
        finish({
          pdf: undefined,
          notes: [{ severity: 'error', message }],
          durationMs,
        });
      }
      return;
    }

    if ('print' in data) {
      // Progress line from busytex
      return;
    }

    if ('exit_code' in data && running) {
      handleCompileReply(data);
    }
  }

  function handleCompileReply(data: { exit_code: number; pdf?: Uint8Array | null; log?: string }) {
    const job = running;
    if (!job) return;

    const durationMs = now() - job.startedAt;

    if (data.exit_code === 0 && data.pdf) {
      const blob = new Blob([data.pdf as unknown as BlobPart], { type: 'application/pdf' });
      finish({ pdf: blob, notes: [...job.latexDiagnostics], durationMs });
    } else {
      const texNotes = parseTexLog(data.log || '', data.exit_code);
      finish({ pdf: undefined, notes: [...job.latexDiagnostics, ...texNotes], durationMs });
    }
  }

  function finish(result: CompileResult) {
    const job = running;
    if (!job) return;
    if (job.timer) clearTimeout(job.timer);
    running = undefined;

    job.resolve(result);

    const next = queued;
    queued = undefined;
    if (next && !disposed) {
      start(next);
    }
  }

  function expire() {
    const job = running;
    if (!job) return;
    terminateWorker();
    const durationMs = budgetMs;
    finish({
      pdf: undefined,
      notes: [
        {
          severity: 'error',
          message: `Compilation timed out (exceeded ${Math.round(budgetMs / 1000)} s).`,
        },
      ],
      durationMs,
    });
  }

  async function start(job: Job) {
    if (disposed) {
      job.resolve(undefined);
      return;
    }

    const startedAt = now();
    running = {
      ...job,
      startedAt,
      latexDiagnostics: [],
      timer: setTimeout(expire, budgetMs),
    };

    // 1. Render LaTeX
    let latexResult: LatexResult;
    try {
      latexResult = await renderLatex(job.project);
    } catch (err) {
      const durationMs = now() - startedAt;
      finish({
        pdf: undefined,
        notes: [
          {
            severity: 'error',
            message: `LaTeX preparation failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        durationMs,
      });
      return;
    }

    if (disposed || running?.id !== job.id) return;
    running.latexDiagnostics = latexResult.diagnostics;

    // If LaTeX is empty, return diagnostics without invoking worker
    if (!latexResult.tex.trim()) {
      const durationMs = now() - startedAt;
      finish({
        pdf: undefined,
        notes: latexResult.diagnostics,
        durationMs,
      });
      return;
    }

    // 2. Ensure worker is initialized
    try {
      await initWorker();
    } catch {
      if (disposed || running?.id !== job.id) return;
      const durationMs = now() - startedAt;
      finish({
        pdf: undefined,
        notes: [
          ...latexResult.diagnostics,
          {
            severity: 'error',
            message: 'Draft PDF engine assets are missing or failed to load. Run `npm run tex:build` to build them.',
          },
        ],
        durationMs,
      });
      return;
    }

    if (disposed || running?.id !== job.id) return;

    // 3. Send compile request to worker
    const workerFiles = [
      { path: 'index.tex', contents: latexResult.tex },
      ...latexResult.files.map((f) => ({ path: f.path, contents: f.bytes })),
    ];

    const currentWorker = worker;
    if (!currentWorker) {
      expire();
      return;
    }

    currentWorker.postMessage({
      files: workerFiles,
      main_tex_path: 'index.tex',
      bibtex: true,
      verbose: 'silent',
      driver: 'pdftex_bibtex8',
      data_packages_js: [`${prefix}tex/galley-tex.js`],
    });
  }

  return {
    compile(project: ProjectSource): Promise<CompileResult | undefined> {
      return new Promise<CompileResult | undefined>((resolve) => {
        const job: Job = { id: ++nextId, project, resolve };
        if (!running) {
          start(job);
          return;
        }
        queued?.resolve(undefined);
        queued = job;
      });
    },
    dispose() {
      disposed = true;
      if (running?.timer) clearTimeout(running.timer);
      running = undefined;
      queued?.resolve(undefined);
      queued = undefined;
      terminateWorker();
    },
  };
}
