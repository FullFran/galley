import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RepoGateway, Repository } from '../domain';
import type { ProjectSource, RenderResult } from '../render';
import { createRenderClient, TOO_COMPLEX } from '../render/client';
import { createCompiler, isRecompileShortcut, type CompileState, type Compiler } from '../compile/compiler';
import { readAutoCompile, writeAutoCompile } from '../compile/preference';
import { describeError, type Buffers } from '../workspace/model';
import { CompileBar } from '../ui/CompileBar';
import { PreviewFrame } from '../ui/PreviewFrame';

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
}

const DEBOUNCE_MS = 300;

/** True when any open file's text differs between two buffer sets. */
function textsDiffer(a: Buffers, b: Buffers): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k]?.text !== b[k]?.text) return true;
  return false;
}

/**
 * Renders the project in a Web Worker and hands the result to the sandboxed
 * preview frame. Edits render on Recompile (Ctrl/Cmd+Enter), or after a pause
 * when auto-compile is on. The renderer lives in the worker's own chunk, so it
 * stays out of the initial bundle, and a document that takes too long to
 * render cannot freeze the editor.
 */
export function Preview({ gateway, repo, headSha, files, buffers, entry, autoCompileDefault = false }: PreviewProps) {
  const [result, setResult] = useState<RenderResult & { seq: number }>();
  const [status, setStatus] = useState<string | undefined>('Loading the preview…');
  const [compile, setCompile] = useState<CompileState>({ compiling: false, stale: false });
  const [auto, setAuto] = useState(() => readAutoCompile(repo.fullName, autoCompileDefault));
  const seq = useRef(0);
  const client = useRef<ReturnType<typeof createRenderClient>>(undefined);
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;

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
          setStatus(`The preview is not available: ${describeError(err)}`);
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

  useEffect(() => compiler.current?.sourceChanged(), [project]);

  const lastBuffers = useRef(buffers);
  useEffect(() => {
    if (textsDiffer(lastBuffers.current, buffers)) compiler.current?.edited();
    lastBuffers.current = buffers;
  }, [buffers]);

  useEffect(() => compiler.current?.setAuto(auto), [auto]);
  useEffect(() => setAuto(readAutoCompile(repo.fullName, autoCompileDefault)), [repo.fullName, autoCompileDefault]);

  // Ctrl/Cmd+Enter anywhere in galley, including inside the editor (captured
  // before CodeMirror, whose default keymap would insert a blank line).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isRecompileShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      compiler.current?.recompile();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <>
      <CompileBar
        compiling={compile.compiling}
        stale={compile.stale}
        lastCompiledAt={compile.lastCompiledAt}
        auto={auto}
        onRecompile={() => compiler.current?.recompile()}
        onAuto={(next) => {
          setAuto(next);
          writeAutoCompile(repo.fullName, next);
        }}
      />
      <PreviewFrame
        seq={result?.seq ?? 0}
        html={result?.html ?? ''}
        assets={result?.assets ?? []}
        diagnostics={result?.diagnostics ?? []}
        status={status}
      />
    </>
  );
}
