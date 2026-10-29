import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { AuthRequiredError, type Repository } from '../../domain';
import type { BuildTarget, CiGateway, DocumentsResult } from '../../github/ci';
import type { Document } from '../../ci/unzip';
import { useT } from '../../i18n';
import { githubUrl } from '../../review/status';
import { Toast } from '../shell/Toasts';
import { toastOutcome } from './pdfView';

interface Link {
  name: string;
  url: string;
}

type State =
  | { kind: 'idle' }
  | { kind: 'fetching' }
  | { kind: 'ready'; pdf: Link; docx?: Link; diff?: Link; runUrl?: string }
  | { kind: Exclude<DocumentsResult['kind'], 'ready'> | 'failed'; runUrl?: string };

const revoke = (s: State) => {
  if (s.kind !== 'ready') return;
  for (const link of [s.pdf, s.docx, s.diff]) if (link) URL.revokeObjectURL(link.url);
};

/**
 * Fetches the compiled paper of a build and offers it as blob downloads in a
 * toast. The links are plain anchors, so the browser download (and the new
 * tab for "Open PDF") come from the person's own click.
 */
export function usePdfDownload(ci: CiGateway | undefined, onAuthRequired?: () => void): {
  start?: (repo: Repository, target: BuildTarget) => void;
  toast: ComponentChildren;
} {
  const t = useT();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const seq = useRef(0);
  const current = useRef(state);
  current.current = state;

  const replace = useCallback((next: State) => {
    revoke(current.current);
    setState(next);
  }, []);

  useEffect(() => () => revoke(current.current), []);

  const start = useCallback(
    (repo: Repository, target: BuildTarget) => {
      if (!ci) return;
      const mine = ++seq.current;
      replace({ kind: 'fetching' });
      ci.documents(repo, target).then(
        (result) => {
          if (mine !== seq.current) return;
          const outcome = toastOutcome(result);
          if (outcome.kind !== 'ready') return replace(outcome);
          const { pdf, docx, diff } = outcome;
          const link = (doc: Document) => ({ name: doc.name, url: URL.createObjectURL(new Blob([doc.bytes as BlobPart], { type: doc.type })) });
          replace({ kind: 'ready', pdf: link(pdf), docx: docx && link(docx), diff: diff && link(diff), runUrl: outcome.runUrl });
        },
        (err: unknown) => {
          if (mine !== seq.current) return;
          if (err instanceof AuthRequiredError && onAuthRequired) return onAuthRequired();
          replace({ kind: 'failed' });
        },
      );
    },
    [ci, replace, onAuthRequired],
  );

  const dismiss = () => {
    seq.current++;
    replace({ kind: 'idle' });
  };
  const m = t.ci;
  const run = state.kind !== 'idle' && state.kind !== 'fetching' ? githubUrl(state.runUrl) : undefined;
  const runLink = run && (
    <a href={run} target="_blank" rel="noopener noreferrer">
      {m.openRun}
    </a>
  );

  let toast: ComponentChildren = null;
  if (state.kind === 'fetching') {
    toast = (
      <Toast onDismiss={dismiss}>
        <p role="status">{m.fetching}</p>
      </Toast>
    );
  } else if (state.kind === 'ready') {
    toast = (
      <Toast tone="ok" onDismiss={dismiss}>
        <div class="ci-download" role="status">
          <p>{m.ready}</p>
          <p class="ci-download-links">
            <a class="button primary" href={state.pdf.url} download={state.pdf.name} data-ci-download="pdf">
              {m.downloadPdf}
            </a>
            <a class="button" href={state.pdf.url} target="_blank" rel="noopener">
              {m.openPdf}
            </a>
            {state.docx && (
              <a class="button" href={state.docx.url} download={state.docx.name} data-ci-download="docx">
                {m.downloadDocx}
              </a>
            )}
            {state.diff && (
              <a class="button" href={state.diff.url} download={state.diff.name}>
                {m.downloadDiff}
              </a>
            )}
          </p>
        </div>
      </Toast>
    );
  } else if (state.kind !== 'idle') {
    const text = { expired: m.expired, running: m.stillRunning, none: m.none, empty: m.empty, failed: m.failed }[state.kind];
    toast = (
      <Toast tone={state.kind === 'failed' || state.kind === 'expired' ? 'danger' : 'warn'} onDismiss={dismiss}>
        <div class="ci-download" role="alert">
          <p>{text}</p>
          {runLink && <p>{runLink}</p>}
        </div>
      </Toast>
    );
  }
  return { start: ci ? start : undefined, toast };
}
