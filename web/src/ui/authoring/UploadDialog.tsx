import { useState } from 'preact/hooks';
import { useT } from '../../i18n';
import { Modal } from '../shell/Modal';

/** One step of an upload, shown in the dialog. */
export type UploadStep =
  | { kind: 'problem'; name: string; message: string }
  /** Ready to add: a preview, and Replace / Keep both when the name is taken. */
  | { kind: 'confirm'; name: string; path: string; url?: string; keepBothPath?: string }
  /** Added to the next save: offer Insert figure with a caption. */
  | { kind: 'added'; name: string; path: string; url?: string; canInsert: boolean };

export interface UploadDialogProps {
  step?: UploadStep;
  onAdd: (choice: 'add' | 'replace' | 'keep-both') => void;
  onInsert: (caption: string) => void;
  onClose: () => void;
}

/**
 * Figure upload: preview (an <img> from a blob: URL; SVG only ever as an
 * image, so its scripts never run), the name check, then Insert figure.
 */
export function UploadDialog({ step, onAdd, onInsert, onClose }: UploadDialogProps) {
  const a = useT().authoring;
  return (
    <Modal open={step !== undefined} onClose={onClose} labelledBy="upload-title" class="authoring-dialog">
      <h2 id="upload-title">{a.uploadTitle}</h2>
      {step?.kind === 'problem' && (
        <>
          <p class="notice notice-danger" role="alert">
            {a.rejected(step.name, step.message)}
          </p>
          <div class="actions">
            <button type="button" class="primary" onClick={onClose}>
              {a.done}
            </button>
          </div>
        </>
      )}
      {(step?.kind === 'confirm' || step?.kind === 'added') && (
        <div class="upload-preview">
          {step.url ? <img src={step.url} alt={a.previewAlt(step.name)} /> : <p class="muted">{a.noPreview}</p>}
        </div>
      )}
      {step?.kind === 'confirm' && (
        <>
          {step.keepBothPath ? (
            <p class="notice notice-warn" role="status">
              {a.collision(step.path)}
            </p>
          ) : (
            <p class="muted">{a.uploadAs(step.path)}</p>
          )}
          <p class="muted">{a.pendingNote}</p>
          <div class="actions">
            {step.keepBothPath ? (
              <>
                <button type="button" class="primary" onClick={() => onAdd('keep-both')}>
                  {a.keepBoth(step.keepBothPath.slice(step.keepBothPath.lastIndexOf('/') + 1))}
                </button>
                <button type="button" onClick={() => onAdd('replace')}>
                  {a.replace}
                </button>
              </>
            ) : (
              <button type="button" class="primary" onClick={() => onAdd('add')}>
                {a.add}
              </button>
            )}
            <button type="button" onClick={onClose}>
              {a.cancel}
            </button>
          </div>
        </>
      )}
      {step?.kind === 'added' && <AddedStep key={step.path} path={step.path} canInsert={step.canInsert} onInsert={onInsert} onClose={onClose} />}
    </Modal>
  );
}

/** Added to the next save: a caption, then Insert figure at the cursor. Keyed by path, so each upload starts empty. */
function AddedStep({ path, canInsert, onInsert, onClose }: { path: string; canInsert: boolean; onInsert: (caption: string) => void; onClose: () => void }) {
  const a = useT().authoring;
  const [caption, setCaption] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onInsert(caption);
      }}
    >
      <p role="status">{a.added(a.summaryUpload(path.slice(path.lastIndexOf('/') + 1)))}</p>
      <label>
        {a.caption}
        <input type="text" maxLength={300} value={caption} onInput={(e) => setCaption(e.currentTarget.value)} />
      </label>
      {!canInsert && <p class="muted">{a.insertNeedsDocument}</p>}
      <div class="actions">
        <button type="submit" class="primary" disabled={!canInsert}>
          {a.insertFigure}
        </button>
        <button type="button" onClick={onClose}>
          {a.done}
        </button>
      </div>
    </form>
  );
}
