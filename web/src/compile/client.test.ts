import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCompileClient,
  parseTexLog,
  type TexWorkerReply,
  type TexWorkerRequest,
  type WorkerLike,
} from './client';
import { memoryProject } from '../render/testProject';
import type { LatexResult } from '../render/latex';
import type { ProjectSource } from '../render';

interface FakeWorkerContext {
  spawn: () => WorkerLike;
  spawned: (WorkerLike & {
    terminated: boolean;
    messages: TexWorkerRequest[];
    triggerMessage: (data: TexWorkerReply) => void;
    triggerError: (err?: Event) => void;
  })[];
}

function fakeTexWorkers(behave?: (worker: FakeWorkerContext['spawned'][0], msg: TexWorkerRequest) => void): FakeWorkerContext {
  const spawned: FakeWorkerContext['spawned'] = [];
  const spawn = () => {
    const worker: FakeWorkerContext['spawned'][0] = {
      terminated: false,
      messages: [],
      onmessage: null,
      onerror: null,
      postMessage(msg: TexWorkerRequest) {
        worker.messages.push(msg);
        if (behave) {
          queueMicrotask(() => {
            if (!worker.terminated) behave(worker, msg);
          });
        }
      },
      terminate() {
        worker.terminated = true;
      },
      triggerMessage(data: TexWorkerReply) {
        queueMicrotask(() => {
          if (!worker.terminated) worker.onmessage?.({ data } as MessageEvent<TexWorkerReply>);
        });
      },
      triggerError(err?: Event) {
        queueMicrotask(() => {
          if (!worker.terminated) worker.onerror?.(err ?? new Event('error'));
        });
      },
    };
    spawned.push(worker);
    return worker;
  };
  return { spawn, spawned };
}

const DUMMY_PDF_BYTES = new Uint8Array([37, 80, 68, 70]); // %PDF

afterEach(() => {
  vi.useRealTimers();
});

describe('parseTexLog', () => {
  it('extracts first ! error line and l.<n> line with line number', () => {
    const log = `
This is pdfTeX, Version 3.141592653-2.6-1.40.25
entering extended mode
! Undefined control sequence.
l.42 \\foobar
Some trailing text
`;
    const notes = parseTexLog(log, 1);
    expect(notes.length).toBe(1);
    const n = notes[0];
    expect(n).toBeDefined();
    if (!n) return;
    expect(n.severity).toBe('error');
    expect(n.message).toContain('! Undefined control sequence.');
    expect(n.message).toContain('l.42 \\foobar');
    expect(n.path).toBe('index.tex');
  });

  it('handles emergency stop and missing sty correctly', () => {
    const log = `
! LaTeX Error: File \`foobar.sty' not found.

Type X to quit or <RETURN> to proceed,
or enter new name. (Default extension: sty)

Enter file name: 
! Emergency stop.
<read *> 
         
l.5 \\usepackage{foobar}
`;
    const notes = parseTexLog(log, 1);
    expect(notes.length).toBe(1);
    const n = notes[0];
    expect(n).toBeDefined();
    if (!n) return;
    expect(n.message).toContain("! LaTeX Error: File `foobar.sty' not found.");
    expect(n.message).toContain('l.5 \\usepackage{foobar}');
  });

  it('falls back to exit code message when no ! line exists', () => {
    const notes = parseTexLog('Fatal error occurred, no output PDF file produced!', 2);
    expect(notes.length).toBe(1);
    const n = notes[0];
    expect(n).toBeDefined();
    if (!n) return;
    expect(n.severity).toBe('error');
    expect(n.message).toMatch(/exit code 2/i);
  });
});

describe('createCompileClient', () => {
  it('inits once and reuses the worker across subsequent compiles', async () => {
    const { spawn, spawned } = fakeTexWorkers((worker, msg) => {
      if ('busytex_wasm' in msg) {
        // Init message
        worker.triggerMessage({ initialized: true });
      } else if ('files' in msg) {
        // Compile message
        worker.triggerMessage({ exit_code: 0, pdf: DUMMY_PDF_BYTES, log: 'all ok' });
      }
    });

    const fakeRenderLatex = async (): Promise<LatexResult> => ({
      tex: '\\documentclass{article}\\begin{document}Hello\\end{document}',
      files: [],
      diagnostics: [],
    });

    const client = createCompileClient(spawn, { renderLatex: fakeRenderLatex });
    const res1 = await client.compile(memoryProject({}));

    expect(spawned.length).toBe(1);
    expect(res1?.pdf).toBeInstanceOf(Blob);
    expect(res1?.notes).toEqual([]);

    // Check messages on first run: init then compile
    const firstWorker = spawned[0];
    expect(firstWorker).toBeDefined();
    if (!firstWorker) return;
    expect(firstWorker.messages.length).toBe(2);
    const firstMsg = firstWorker.messages[0];
    const secondMsg = firstWorker.messages[1];
    expect(firstMsg && 'busytex_wasm' in firstMsg).toBe(true);
    expect(secondMsg && 'files' in secondMsg).toBe(true);
    expect(secondMsg && 'bibtex' in secondMsg && secondMsg.bibtex).toBe(true);

    // Second compile: worker is reused and NOT re-initialized
    const res2 = await client.compile(memoryProject({}));
    expect(spawned.length).toBe(1);
    expect(res2?.pdf).toBeInstanceOf(Blob);
    expect(firstWorker.messages.length).toBe(3);
    const thirdMsg = firstWorker.messages[2];
    expect(thirdMsg && 'files' in thirdMsg).toBe(true);
  });

  it('replaces queued compiles when a new request arrives', async () => {
    let resolveFirst: (() => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    const firstCompileDone = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const secondCompileDone = new Promise<void>((r) => {
      resolveSecond = r;
    });

    let compileCount = 0;
    const { spawn } = fakeTexWorkers((worker, msg) => {
      if ('busytex_wasm' in msg) {
        worker.triggerMessage({ initialized: true });
      } else if ('files' in msg) {
        compileCount++;
        if (compileCount === 1) {
          void firstCompileDone.then(() => worker.triggerMessage({ exit_code: 0, pdf: DUMMY_PDF_BYTES }));
        } else {
          void secondCompileDone.then(() => worker.triggerMessage({ exit_code: 0, pdf: DUMMY_PDF_BYTES }));
        }
      }
    });

    const fakeRenderLatex = async (project: ProjectSource): Promise<LatexResult> => ({
      tex: `\\documentclass{article}\\begin{document}${project.entry ?? 'doc'}\\end{document}`,
      files: [],
      diagnostics: [],
    });

    const client = createCompileClient(spawn, { renderLatex: fakeRenderLatex });

    const projA = memoryProject({ 'a.qmd': 'first' });
    projA.entry = 'a.qmd';
    const projB = memoryProject({ 'b.qmd': 'second' });
    projB.entry = 'b.qmd';
    const projC = memoryProject({ 'c.qmd': 'third' });
    projC.entry = 'c.qmd';

    const p1 = client.compile(projA);
    const p2 = client.compile(projB);
    const p3 = client.compile(projC);

    // p1 is running. p2 was queued, then replaced by p3.
    resolveFirst?.();
    const r1 = await p1;
    const r2 = await p2;
    expect(r1?.pdf).toBeDefined();
    expect(r2).toBeUndefined(); // p2 was replaced

    resolveSecond?.();
    const r3 = await p3;
    expect(r3?.pdf).toBeDefined();
  });

  it('terminates worker on timeout and recreates next time', async () => {
    vi.useFakeTimers();

    const { spawn, spawned } = fakeTexWorkers((worker, msg) => {
      if ('busytex_wasm' in msg) {
        worker.triggerMessage({ initialized: true });
      }
      // Never replies to compile
    });

    const fakeRenderLatex = async (): Promise<LatexResult> => ({
      tex: '\\documentclass{article}\\begin{document}Slow\\end{document}',
      files: [],
      diagnostics: [],
    });

    const client = createCompileClient(spawn, { budgetMs: 60_000, renderLatex: fakeRenderLatex });

    const pending = client.compile(memoryProject({}));
    await vi.advanceTimersByTimeAsync(60_000);

    const out = await pending;
    expect(out?.pdf).toBeUndefined();
    expect(out?.notes.some((n) => n.message.includes('timed out'))).toBe(true);
    expect(spawned[0]?.terminated).toBe(true);

    // Next compile spawns a fresh worker
    const { spawn: spawn2, spawned: spawned2 } = fakeTexWorkers((worker, msg) => {
      if ('busytex_wasm' in msg) worker.triggerMessage({ initialized: true });
      else if ('files' in msg) worker.triggerMessage({ exit_code: 0, pdf: DUMMY_PDF_BYTES });
    });
    const client2 = createCompileClient(spawn2, { budgetMs: 60_000, renderLatex: fakeRenderLatex });
    const res = await client2.compile(memoryProject({}));
    expect(res?.pdf).toBeDefined();
    expect(spawned2.length).toBe(1);
  });

  it('turns TeX compile errors into readable notes', async () => {
    const { spawn } = fakeTexWorkers((worker, msg) => {
      if ('busytex_wasm' in msg) {
        worker.triggerMessage({ initialized: true });
      } else if ('files' in msg) {
        worker.triggerMessage({
          exit_code: 1,
          pdf: null,
          log: `
This is pdfTeX, Version 3.141592653-2.6-1.40.25
! Undefined control sequence.
l.15 \\badcommand
`,
        });
      }
    });

    const fakeRenderLatex = async (): Promise<LatexResult> => ({
      tex: '\\documentclass{article}\\begin{document}\\badcommand\\end{document}',
      files: [],
      diagnostics: [],
    });

    const client = createCompileClient(spawn, { renderLatex: fakeRenderLatex });
    const res = await client.compile(memoryProject({}));

    expect(res?.pdf).toBeUndefined();
    expect(res?.notes.length).toBe(1);
    const n = res?.notes[0];
    expect(n).toBeDefined();
    if (!n) return;
    expect(n.severity).toBe('error');
    expect(n.message).toContain('! Undefined control sequence.');
    expect(n.message).toContain('l.15 \\badcommand');
  });

  it('handles missing assets gracefully without crashing', async () => {
    const { spawn } = fakeTexWorkers((worker, msg) => {
      if ('busytex_wasm' in msg) {
        // Simulates 404 / missing assets on init
        worker.triggerMessage({ exception: 'Exception during initialization: Failed to fetch /tex/busytex.wasm: 404' });
      }
    });

    const fakeRenderLatex = async (): Promise<LatexResult> => ({
      tex: '\\documentclass{article}\\begin{document}Hello\\end{document}',
      files: [],
      diagnostics: [],
    });

    const client = createCompileClient(spawn, { renderLatex: fakeRenderLatex });
    const res = await client.compile(memoryProject({}));

    expect(res?.pdf).toBeUndefined();
    expect(res?.notes.length).toBeGreaterThan(0);
    const n = res?.notes[0];
    expect(n).toBeDefined();
    if (!n) return;
    expect(n.severity).toBe('error');
    expect(n.message).toMatch(/assets.*missing|tex:build/i);
  });

  it('passes renderLatex diagnostics through', async () => {
    const { spawn } = fakeTexWorkers((worker, msg) => {
      if ('busytex_wasm' in msg) worker.triggerMessage({ initialized: true });
      else if ('files' in msg) worker.triggerMessage({ exit_code: 0, pdf: DUMMY_PDF_BYTES });
    });

    const fakeRenderLatex = async (): Promise<LatexResult> => ({
      tex: '\\documentclass{article}\\begin{document}Hello\\end{document}',
      files: [],
      diagnostics: [{ severity: 'warning', message: 'Figure not found: missing.png' }],
    });

    const client = createCompileClient(spawn, { renderLatex: fakeRenderLatex });
    const res = await client.compile(memoryProject({}));

    expect(res?.pdf).toBeDefined();
    expect(res?.notes).toEqual([{ severity: 'warning', message: 'Figure not found: missing.png' }]);
  });
});
