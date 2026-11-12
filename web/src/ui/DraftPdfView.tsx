import type { Diagnostic } from '../render';
import { useT } from '../i18n';
import { useObjectUrl } from './ci/CompiledPdf';

export interface DraftPdfViewProps {
  pdf?: Blob;
  compiling: boolean;
  notes: Diagnostic[];
  downloadName?: string;
  firstCompile?: boolean;
}

export function DraftPdfView({
  pdf,
  compiling,
  notes,
  downloadName = 'draft.pdf',
  firstCompile = false,
}: DraftPdfViewProps) {
  const t = useT();
  const m = t.draftPdf;
  const url = useObjectUrl(pdf);
  const problems = notes.filter((d) => d.severity !== 'info').length;

  let body;
  if (url) {
    body = <iframe class="pdf-view-frame" src={url} title={m.frameTitle} />;
  } else if (compiling) {
    body = (
      <div class="pdf-view-message" role="status">
        <p class="muted">{firstCompile ? m.downloadingEngine : m.compiling}</p>
      </div>
    );
  } else if (notes.length > 0) {
    body = (
      <div class="pdf-view-message" role="alert">
        <p>{m.failed}</p>
      </div>
    );
  } else {
    body = (
      <div class="pdf-view-message" role="status">
        <p class="muted">{m.compiling}</p>
      </div>
    );
  }

  return (
    <div class="pdf-view preview-draft-pdf">
      <div class="pdf-view-bar">
        <p class="pdf-view-label" title={m.officialNotice}>
          <span class="chip chip-warn">{m.tab}</span>{' '}
          <span class="muted pdf-draft-notice">{m.officialNotice}</span>
        </p>
        <div class="pdf-view-actions">
          {compiling && (
            <span class="muted pdf-view-note" role="status">
              {firstCompile ? m.downloadingEngine : m.compiling}
            </span>
          )}
          {url && (
            <>
              <a class="button primary" href={url} download={downloadName} data-pdf-download>
                {t.ci.pdfView.download}
              </a>
              <a class="button" href={url} target="_blank" rel="noopener">
                {t.ci.pdfView.open}
              </a>
            </>
          )}
        </div>
      </div>
      {body}
      <div class="preview-status" aria-live="polite">
        {notes.length > 0 && (
          <details class="preview-notes" open={!url}>
            <summary>{t.preview.notes(notes.length, problems)}</summary>
            <ul>
              {notes.map((d, i) => (
                <li key={i} class={`note-${d.severity}`}>
                  {d.message}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
