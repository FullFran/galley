import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { AuthRequiredError, type Repository } from '../../domain';
import type { CiGateway } from '../../github/ci';
import { useT } from '../../i18n';
import { githubUrl } from '../../review/status';
import { buildLabel, compiledPdfState, needsFetch, sessionPdfCache, type CompiledPdf, type PdfCache } from './pdfView';

/**
 * The latest compiled PDF of the default branch, for the PDF layout. Mounted
 * only while that layout is chosen, so nothing downloads in the background;
 * a PDF already fetched in this session shows again without a download.
 */
export function useCompiledPdf(
  ci: CiGateway | undefined,
  repo: Repository,
  onAuthRequired?: () => void,
  cache: PdfCache = sessionPdfCache,
): { state: CompiledPdf; refreshing: boolean; refreshFailed: boolean; refresh?: () => void } {
  const branch = repo.defaultBranch;
  const initial = (): CompiledPdf => (ci ? (cache.get(repo.fullName, branch) ?? { kind: 'loading' }) : { kind: 'unavailable' });
  const [state, setState] = useState<CompiledPdf>(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const seq = useRef(0);
  const authRef = useRef(onAuthRequired);
  authRef.current = onAuthRequired;
  // Read through a ref: a new Repository object for the same repository must not refetch.
  const repoRef = useRef(repo);
  repoRef.current = repo;
  const name = repo.fullName;

  const fetchPdf = useCallback(() => {
    if (!ci) return;
    const mine = ++seq.current;
    const shown = cache.get(name, branch);
    setRefreshFailed(false);
    if (shown) setRefreshing(true);
    else setState({ kind: 'loading' });
    ci.documents(repoRef.current, { branch }).then(
      (result) => {
        if (mine !== seq.current) return;
        setRefreshing(false);
        const next = compiledPdfState(result);
        // A refresh that finds no PDF keeps showing the last good one.
        if (next.kind !== 'ready' && shown) return setRefreshFailed(true);
        setState(cache.put(name, branch, next));
      },
      (err: unknown) => {
        if (mine !== seq.current) return;
        setRefreshing(false);
        if (err instanceof AuthRequiredError && authRef.current) authRef.current();
        if (shown) setRefreshFailed(true);
        else setState({ kind: 'failed' });
      },
    );
  }, [ci, name, branch, cache]);

  useEffect(() => {
    const cached = ci ? cache.get(name, branch) : undefined;
    setState(ci ? (cached ?? { kind: 'loading' }) : { kind: 'unavailable' });
    setRefreshing(false);
    setRefreshFailed(false);
    if (needsFetch(true, ci !== undefined, cached)) fetchPdf();
    // A repository switch or unmount drops the answer of a fetch still going.
    return () => void seq.current++;
  }, [ci, name, branch, cache, fetchPdf]);

  return { state, refreshing, refreshFailed, refresh: ci ? fetchPdf : undefined };
}

/** An object URL for `blob`, revoked when the blob changes or the view unmounts. */
function useObjectUrl(blob: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return setUrl(undefined);
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

export interface CompiledPdfViewProps {
  ci?: CiGateway;
  repo: Repository;
  onAuthRequired?: () => void;
}

/**
 * The PDF layout's second pane: a label naming the build (branch, commit and
 * time), Download, Open in new tab and Refresh, and the PDF itself in the
 * browser's own viewer (which zooms and searches). The frame shows a blob:
 * URL of type application/pdf (CSP frame-src blob:); if the browser does not
 * show PDFs inline, Open and Download still work.
 */
export function CompiledPdfView({ ci, repo, onAuthRequired }: CompiledPdfViewProps) {
  const t = useT();
  const m = t.ci.pdfView;
  const { state, refreshing, refreshFailed, refresh } = useCompiledPdf(ci, repo, onAuthRequired);
  const ready = state.kind === 'ready' ? state : undefined;
  const url = useObjectUrl(ready?.pdf);
  const branch = repo.defaultBranch;
  const run = state.kind !== 'unavailable' && state.kind !== 'loading' ? githubUrl(state.runUrl) : undefined;
  const runLink = run && (
    <a href={run} target="_blank" rel="noopener noreferrer">
      {t.ci.openRun}
    </a>
  );

  const label = ready ? buildLabel(ready.build, branch, t.meta.lang, m) : m.label(branch);
  const refreshButton = refresh && state.kind !== 'loading' && (
    <button type="button" class="button" onClick={refresh} disabled={refreshing} title={m.refreshTitle} data-pdf-refresh>
      {refreshing ? t.ci.fetching : m.refresh}
    </button>
  );

  let body;
  if (state.kind === 'ready') {
    body = url && <iframe class="pdf-view-frame" src={url} title={m.frameTitle(branch)} />;
  } else if (state.kind === 'loading') {
    body = (
      <p class="pdf-view-message muted" role="status">
        {m.loading(branch)}
      </p>
    );
  } else {
    const text = {
      unavailable: m.unavailable,
      none: m.none(branch),
      empty: t.ci.empty,
      expired: t.ci.expired,
      running: t.ci.stillRunning,
      failed: t.ci.failed,
    }[state.kind];
    body = (
      <div class="pdf-view-message" role={state.kind === 'failed' || state.kind === 'expired' ? 'alert' : 'status'} data-pdf-state={state.kind}>
        <p>{text}</p>
        {runLink && <p>{runLink}</p>}
      </div>
    );
  }

  return (
    <div class="pdf-view" data-pdf-state={state.kind}>
      <div class="pdf-view-bar">
        <p class="pdf-view-label" title={label}>
          {label}
        </p>
        <div class="pdf-view-actions">
          {ready && url && (
            <>
              <a class="button primary" href={url} download={ready.name} data-pdf-download>
                {m.download}
              </a>
              <a class="button" href={url} target="_blank" rel="noopener">
                {m.open}
              </a>
            </>
          )}
          {refreshButton}
        </div>
      </div>
      {refreshFailed && (
        <p class="pdf-view-note muted" role="status">
          {t.ci.failed} {runLink}
        </p>
      )}
      {body}
      {ready && <p class="pdf-view-note muted">{m.inlineHint}</p>}
    </div>
  );
}
