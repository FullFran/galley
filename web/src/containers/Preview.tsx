import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RepoGateway, Repository } from '../domain';
import type { ProjectSource, RenderResult } from '../render';
import { createRenderClient, TOO_COMPLEX } from '../render/client';
import type { CompileClient, CompileResult } from '../compile/client';
import { createCompiler, isRecompileShortcut, type CompileState, type Compiler } from '../compile/compiler';
import { readAutoCompile, writeAutoCompile } from '../compile/preference';
import { readPrefs, writePrefs, type PreviewMode } from '../shell/prefs';
import { describeError, textsEdited, type Buffers } from '../workspace/model';
import { useT } from '../i18n';
import { CompileBar } from '../ui/CompileBar';
import { DraftPdfView } from '../ui/DraftPdfView';
import { PreviewFrame, type PreviewFrameProps } from '../ui/PreviewFrame';

export interface PreviewProps {
  gateway: RepoGateway;
  repo: Repository;
  headSha: string;
  files: string[];
  /** Open files; their current text wins over the repository content. */
  buffers: Buffers;
  /** Entry document from `.galley.yml`, if any. */
  entry?: string;
  /** `preview.auto_compile` from `.galley.yml`; the user's own choice wins. */
  autoCompileDefault?: boolean;
  /** Heading to scroll the preview to, from the outline. */
  scrollTo?: { id?: string; text: string; seq: number };
  /** Bumped by "Recompile now" in the header ⋯ menu. */
  recompileSeq?: number;
  /** Selections and double-clicks in the preview, and blocks to reveal (source tags). */
  onSelection?: PreviewFrameProps['onSelection'];
  onJump?: PreviewFrameProps['onJump'];
  reveal?: PreviewFrameProps['reveal'];
}

const DEBOUNCE_MS = 300;
const PDF_DEBOUNCE_MS = 1500;

/**
 * Renders the project in a Web Worker and hands the result to the sandboxed
 * preview frame, or compiles a draft PDF in the browser with BusyTeX.
 * Edits render on Recompile (Ctrl/Cmd+Enter), or after a pause when auto-compile
 * is on. The renderer and TeX engine live in their own worker chunks, so they
 * stay out of the initial bundle, and complex documents cannot freeze the editor.
 */
export function Preview({ gateway, repo, headSha, files, buffers, entry, autoCompileDefault = false, scrollTo, recompileSeq, ...frameLinks }: PreviewProps) {
  const [result, setResult] = useState<RenderResult & { seq: number }>();
  const [mode, setModeState] = useState<PreviewMode>(() => readPrefs().previewMode ?? 'html');
  const [pdfResult, setPdfResult] = useState<CompileResult & { seq: number }>();
  const [pdfCompile, setPdfCompile] = useState<CompileState>({ compiling: false, stale: false });
  const [pdfFirstCompile, setPdfFirstCompile] = useState(true);

  const t = useT();
  // Kept as data, so the text follows a language switch.
  const [status, setStatus] = useState<{ kind: 'loading' } | { kind: 'failed'; error: unknown } | undefined>({ kind: 'loading' });
  const [compile, setCompile] = useState<CompileState>({ compiling: false, stale: false });
  const [printReq, setPrintReq] = useState<{ note: string; seq: number }>();
  const [auto, setAuto] = useState(() => readAutoCompile(repo.fullName, autoCompileDefault));

  const seq = useRef(0);
  const pdfSeq = useRef(0);
  const client = useRef<ReturnType<typeof createRenderClient>>(undefined);
  const texClient = useRef<CompileClient>(undefined);
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;

  const setMode = (next: PreviewMode) => {
    setModeState(next);
    writePrefs({ ...readPrefs(), previewMode: next });
  };

  // Repository reads are cached per commit; unsaved buffers are read live.
  const project = useMemo<ProjectSource>(() => {
    const texts = new Map<string, Promise<string>>();
    const bytes = new Map<string, Promise<Uint8Array>>();
    const cached = <T,>(cache: Map<string, Promise<T>>, path: string, read: () => Promise<T>) => {
      let p = cache.get(path);
      if (!p) {
        p = read();
        cache.set(path, p);
        p.catch(() => cache.delete(path));
      }
      return p;
    };
    return {
      files,
      entry,
      readText: (path) => {
        const open = buffersRef.current[path];
        if (open) return Promise.resolve(open.text);
        return cached(texts, path, () => gateway.readFile(repo, path, headSha));
      },
      readBytes: (path) => cached(bytes, path, () => gateway.readBytes(repo, path, headSha)),
    };
  }, [gateway, repo, headSha, files, entry]);
  const projectRef = useRef(project);
  projectRef.current = project;

  const compiler = useRef<Compiler>(undefined);
  useEffect(() => {
    const c = createCompiler({
      auto,
      debounceMs: DEBOUNCE_MS,
      onState: setCompile,
      run: async () => {
        client.current ??= createRenderClient();
        try {
          const out = await client.current.render(projectRef.current);
          if (!out) return;
          seq.current += 1;
          // Keep the last good preview when a render runs over budget.
          setResult((prev) =>
            out === TOO_COMPLEX && prev ? { ...prev, diagnostics: out.diagnostics, seq: seq.current } : { ...out, seq: seq.current },
          );
          setStatus(undefined);
        } catch (err) {
          setStatus({ kind: 'failed', error: err });
        }
      },
    });
    compiler.current = c;
    return () => {
      c.dispose();
      client.current?.dispose();
    };
    // The compiler lives as long as the preview; later `auto` changes go through setAuto.
  }, []);

  const pdfCompiler = useRef<Compiler>(undefined);
  useEffect(() => {
    const c = createCompiler({
      auto,
      debounceMs: PDF_DEBOUNCE_MS,
      onState: setPdfCompile,
      run: async () => {
        if (!texClient.current) {
          const { createCompileClient } = await import('../compile/client');
          texClient.current = createCompileClient();
        }
        try {
          const out = await texClient.current.compile(projectRef.current);
          if (!out) return;
          pdfSeq.current += 1;
          setPdfFirstCompile(false);
          setPdfResult((prev) => {
            if (out.pdf) {
              return { ...out, seq: pdfSeq.current };
            }
            if (prev?.pdf) {
              return { ...prev, notes: out.notes, seq: pdfSeq.current };
            }
            return { ...out, seq: pdfSeq.current };
          });
        } catch {
          // Handled inside compile client
        }
      },
    });
    pdfCompiler.current = c;
    return () => {
      c.dispose();
      texClient.current?.dispose();
    };
  }, []);

  const onRecompile = () => {
    if (mode === 'pdf') {
      pdfCompiler.current?.recompile();
    } else {
      compiler.current?.recompile();
    }
  };

  useEffect(() => {
    if (mode === 'pdf') {
      if (!pdfResult) {
        pdfCompiler.current?.sourceChanged();
      }
    }
  }, [mode]);

  useEffect(() => {
    compiler.current?.sourceChanged();
    if (mode === 'pdf') {
      pdfCompiler.current?.sourceChanged();
    }
  }, [project]);

  const lastBuffers = useRef(buffers);
  useEffect(() => {
    if (textsEdited(lastBuffers.current, buffers)) {
      compiler.current?.edited();
      if (mode === 'pdf') {
        pdfCompiler.current?.edited();
      }
    }
    lastBuffers.current = buffers;
  }, [buffers, mode]);

  useEffect(() => {
    compiler.current?.setAuto(auto);
    pdfCompiler.current?.setAuto(auto);
  }, [auto]);

  useEffect(() => {
    if (recompileSeq) onRecompile();
  }, [recompileSeq]);

  useEffect(() => setAuto(readAutoCompile(repo.fullName, autoCompileDefault)), [repo.fullName, autoCompileDefault]);

  // Ctrl/Cmd+Enter anywhere in galley, including inside the editor (captured
  // before CodeMirror, whose default keymap would insert a blank line).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isRecompileShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      onRecompile();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mode]);

  const activeCompile = mode === 'pdf' ? pdfCompile : compile;
  const downloadName = `${entry?.replace(/\.[^/.]+$/, '') || repo.name || 'document'}-draft.pdf`;

  return (
    <>
      <CompileBar
        compiling={activeCompile.compiling}
        stale={activeCompile.stale}
        lastCompiledAt={activeCompile.lastCompiledAt}
        auto={auto}
        onRecompile={onRecompile}
        onPrint={mode === 'html' && result?.html ? () => setPrintReq((r) => ({ note: t.print.note, seq: (r?.seq ?? 0) + 1 })) : undefined}
        onAuto={(next) => {
          setAuto(next);
          writeAutoCompile(repo.fullName, next);
        }}
        mode={mode}
        onMode={setMode}
      />
      {mode === 'html' ? (
        <PreviewFrame
          seq={result?.seq ?? 0}
          html={result?.html ?? ''}
          assets={result?.assets ?? []}
          diagnostics={result?.diagnostics ?? []}
          status={
            status === undefined
              ? undefined
              : status.kind === 'loading'
                ? t.preview.loading
                : t.preview.unavailable(describeError(status.error, t))
          }
          scrollTo={scrollTo}
          print={printReq}
          {...frameLinks}
        />
      ) : (
        <DraftPdfView
          pdf={pdfResult?.pdf}
          compiling={pdfCompile.compiling}
          notes={pdfResult?.notes ?? []}
          firstCompile={pdfFirstCompile && !pdfResult?.pdf}
          downloadName={downloadName}
        />
      )}
    </>
  );
}
