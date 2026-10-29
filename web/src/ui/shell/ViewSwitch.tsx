import { useT } from '../../i18n';
import type { PaneView } from '../../shell/viewOptions';

export type { PaneView };

/**
 * Edit | Preview: the one-click switch between the text only and the preview
 * only (also Ctrl+Alt+V). The pressed half is the pane shown; while editor and
 * preview show side by side neither is pressed, and either half shows that
 * pane alone. With the PDF layout the second half is the compiled PDF.
 */
export function ViewSwitch({ view, pdf = false, onView }: { view: PaneView | undefined; pdf?: boolean; onView: (view: PaneView) => void }) {
  const t = useT();
  const m = t.workspace;
  return (
    <div class="segmented view-switch" role="group" aria-label={m.show} aria-keyshortcuts="Control+Alt+V Meta+Alt+V">
      <button type="button" aria-pressed={view === 'edit'} title={`${t.view.editorOnly} (Ctrl+Alt+V)`} onClick={() => onView('edit')}>
        {m.edit}
      </button>
      <button
        type="button"
        aria-pressed={view === 'preview'}
        title={`${pdf ? t.view.pdfOnly : t.view.previewOnly} (Ctrl+Alt+V)`}
        onClick={() => onView('preview')}>
        {pdf ? t.view.pdf : m.preview}
      </button>
    </div>
  );
}
