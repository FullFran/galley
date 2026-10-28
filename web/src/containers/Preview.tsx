import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RepoGateway, Repository } from '../domain';
import type { ProjectSource, RenderResult } from '../render';
import { createRenderClient, TOO_COMPLEX } from '../render/client';
import { describeError, type Buffers } from '../workspace/model';
import { PreviewFrame } from '../ui/PreviewFrame';

export interface PreviewProps {
  gateway: RepoGateway;
  repo: Repository;
  headSha: string;
  files: string[];
  /** Open files; their current text wins over the repository content. */
  buffers: Buffers;
}

const DEBOUNCE_MS = 300;

/**
 * Renders the project on every edit (debounced) in a Web Worker and hands the
 * result to the sandboxed preview frame. The renderer lives in the worker's
 * own chunk, so it stays out of the initial bundle, and a document that takes
 * too long to render cannot freeze the editor.
 */
export function Preview({ gateway, repo, headSha, files, buffers }: PreviewProps) {
  const [result, setResult] = useState<RenderResult & { seq: number }>();
  const [status, setStatus] = useState<string | undefined>('Loading the preview…');
  const seq = useRef(0);
  const client = useRef<ReturnType<typeof createRenderClient>>(undefined);
  useEffect(() => () => client.current?.dispose(), []);
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
      readText: (path) => {
        const open = buffersRef.current[path];
        if (open) return Promise.resolve(open.text);
        return cached(texts, path, () => gateway.readFile(repo, path, headSha));
      },
      readBytes: (path) => cached(bytes, path, () => gateway.readBytes(repo, path, headSha)),
    };
  }, [gateway, repo, headSha, files]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(
      () => {
        client.current ??= createRenderClient();
        client.current
          .render(project)
          .then((out) => {
            if (cancelled || !out) return;
            seq.current += 1;
            // Keep the last good preview when a render runs over budget.
            setResult((prev) =>
              out === TOO_COMPLEX && prev ? { ...prev, diagnostics: out.diagnostics, seq: seq.current } : { ...out, seq: seq.current },
            );
            setStatus(undefined);
          })
          .catch((err: unknown) => {
            if (!cancelled) setStatus(`The preview is not available: ${describeError(err)}`);
          });
      },
      seq.current === 0 ? 0 : DEBOUNCE_MS,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [project, buffers]);

  return (
    <PreviewFrame
      seq={result?.seq ?? 0}
      html={result?.html ?? ''}
      assets={result?.assets ?? []}
      diagnostics={result?.diagnostics ?? []}
      status={status}
    />
  );
}
