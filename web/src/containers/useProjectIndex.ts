import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { BlobInfo, RepoGateway, Repository } from '../domain';
import { createIndexer } from '../editor/indexClient';
import { isBib, isText, type ProjectIndex } from '../editor/projectIndex';
import { createTextCache } from '../editor/textCache';
import type { Buffers } from '../workspace/model';

/** Files read for the index; a paper has far fewer, and this bounds the GitHub reads. */
export const MAX_INDEX_FILES = 300;
const DEBOUNCE_MS = 500;
const NO_BLOBS: Record<string, BlobInfo> = {};

/**
 * The project index for autocomplete, warnings and go to definition. Reads
 * every .qmd, .md and .bib file once per blob (open buffers win, unchanged
 * files carry over between commits), and rebuilds in a worker a moment after
 * edits stop.
 */
export function useProjectIndex(
  gateway: RepoGateway,
  repo: Repository,
  headSha: string | undefined,
  files: readonly string[],
  blobs: Readonly<Record<string, BlobInfo>> | undefined,
  buffers: Buffers,
  entry: string | undefined,
): { index?: ProjectIndex; version: number } {
  const [state, setState] = useState<{ index?: ProjectIndex; version: number }>({ version: 0 });
  const indexer = useRef<ReturnType<typeof createIndexer>>(undefined);
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;

  const cache = useMemo(() => createTextCache((path, ref) => gateway.readFile(repo, path, ref)), [gateway, repo]);
  const sources = useMemo(() => files.filter((p) => isText(p) || isBib(p)).slice(0, MAX_INDEX_FILES), [files]);

  useEffect(() => () => indexer.current?.dispose(), []);

  // Only the text of indexed files matters; other edits do not rebuild.
  const textKey = useMemo(() => sources.map((p) => buffers[p]?.text ?? '').join('\u0000'), [sources, buffers]);
  const hasIndex = state.index !== undefined;

  useEffect(() => {
    if (!headSha) return;
    let current = true;
    const timer = setTimeout(async () => {
      const closed = sources.filter((p) => !buffersRef.current[p]);
      const read = await cache.texts(closed, blobs ?? NO_BLOBS, headSha);
      if (!current) return;
      const texts = new Map(read.map((r) => [r.path, r.text]));
      const open = buffersRef.current;
      indexer.current ??= createIndexer();
      const index = await indexer.current.build({
        files: sources.flatMap((path) => {
          const text = open[path]?.text ?? texts.get(path);
          return text === undefined ? [] : [{ path, text }];
        }),
        paths: [...files],
        entry,
      });
      if (current && index) setState((s) => ({ index, version: s.version + 1 }));
    }, hasIndex ? DEBOUNCE_MS : 0);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // `textKey` stands for the buffers' text; `hasIndex` only picks the first delay.
  }, [cache, headSha, files, blobs, sources, entry, textKey]);

  return state;
}
