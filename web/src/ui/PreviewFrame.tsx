import { useEffect, useRef, useState } from 'preact/hooks';
import type { Diagnostic, PreviewAsset } from '../render';
import { PREVIEW_RENDER, createReadyGate, parseFrameMessage, type RenderMessage } from '../preview/protocol';

export interface PreviewFrameProps {
  /** Increases with every new render, so the frame ignores stale messages. */
  seq: number;
  html: string;
  assets: PreviewAsset[];
  diagnostics: Diagnostic[];
  /** Shown instead of the frame contents' state, e.g. while the renderer loads. */
  status?: string;
}

/**
 * The rendered paper, shown in a sandboxed frame with an opaque origin
 * (`sandbox="allow-scripts"` without `allow-same-origin`): repository content
 * can never reach galley's DOM, storage or GitHub token. The frame and galley
 * talk only through validated postMessage calls.
 */
export function PreviewFrame({ seq, html, assets, diagnostics, status }: PreviewFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const gate = useRef(createReadyGate());
  // Counts accepted ready messages, so a reloaded frame receives the current content again.
  const [ready, setReady] = useState(0);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return;
      if (parseFrameMessage(event.data) && gate.current.ready()) setReady((n) => n + 1);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    const target = frame.current?.contentWindow;
    if (!ready || !target || !gate.current.canPost()) return;
    const message: RenderMessage = {
      type: PREVIEW_RENDER,
      seq,
      html,
      assets: assets.map(({ id, type, bytes }) => ({ id, type, bytes })),
    };
    // An opaque-origin frame can only be addressed with '*'. The frame cannot
    // navigate away (no top navigation, links are blocked inside it), so the
    // receiver is always galley's own preview page.
    target.postMessage(message, '*');
  }, [ready, seq, html, assets]);

  const problems = diagnostics.filter((d) => d.severity !== 'info').length;
  return (
    <div class="preview">
      <iframe
        ref={frame}
        class="preview-frame"
        title="Preview of the paper"
        src={`${import.meta.env.BASE_URL}preview.html`}
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        onLoad={() => gate.current.loaded()}
      />
      <div class="preview-status" aria-live="polite">
        {status && <span class="muted">{status}</span>}
        {diagnostics.length > 0 && (
          <details class="preview-notes">
            <summary>
              {diagnostics.length} preview note{diagnostics.length === 1 ? '' : 's'}
              {problems > 0 && ` (${problems} to check)`}
            </summary>
            <ul>
              {diagnostics.map((d, i) => (
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
