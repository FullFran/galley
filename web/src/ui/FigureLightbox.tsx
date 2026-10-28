import { useT } from '../i18n';
import { Modal } from './shell/Modal';

export type FigureState = { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'pdf' } | { kind: 'failed' } | { kind: 'too-large' };

/** The figure itself. Images come from a data: URL (the app CSP allows `img-src 'self' data:`). */
export function FigureView({ path, state }: { path: string; state: FigureState }) {
  const m = useT().editor;
  switch (state.kind) {
    case 'loading':
      return <p class="muted">{m.loadingImage}</p>;
    case 'pdf':
      return <p class="muted">{m.pdfFigure}</p>;
    case 'too-large':
      return <p class="muted">{m.imageTooLarge}</p>;
    case 'failed':
      return <p role="alert">{m.imageFailed}</p>;
    case 'ready':
      return <img class="figure-lightbox-image" src={state.url} alt={path} />;
  }
}

export interface FigureLightboxProps {
  path?: string;
  state: FigureState;
  onClose: () => void;
}

/** A figure opened from the editor ("go to definition" on an image path). */
export function FigureLightbox({ path, state, onClose }: FigureLightboxProps) {
  const m = useT().editor;
  return (
    <Modal open={path !== undefined} onClose={onClose} labelledBy="figure-title" class="figure-lightbox">
      <h2 id="figure-title" class="figure-lightbox-title">
        {m.image}: <code>{path}</code>
      </h2>
      {path !== undefined && <FigureView path={path} state={state} />}
      <div class="actions">
        <button type="button" class="primary" onClick={onClose}>
          {m.closeImage}
        </button>
      </div>
    </Modal>
  );
}
