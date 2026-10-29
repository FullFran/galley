import { useT } from '../../i18n';
import type { PaneView } from '../../shell/viewOptions';

export type { PaneView };

/**
 * Edit | Preview: the one-click switch between the text only and the preview
 * only (also Ctrl+Alt+V). The pressed half is the pane shown; while editor and
 * preview show side by side neither is pressed, and either half shows that
 * pane alone.
 */
export function ViewSwitch({ view, onView }: { view: PaneView | undefined; onView: (view: PaneView) => void }) {
  const t = useT();
  const m = t.workspace;
  return (
    <div class="segmented view-switch" role="group" aria-label={m.show} aria-keyshortcuts="Control+Alt+V Meta+Alt+V">
      <button type="button" aria-pressed={view === 'edit'} title={`${t.view.editorOnly} (Ctrl+Alt+V)`} onClick={() => onView('edit')}>
        {m.edit}
      </button>
      <button type="button" aria-pressed={view === 'preview'} title={`${t.view.previewOnly} (Ctrl+Alt+V)`} onClick={() => onView('preview')}>
        {m.preview}
      </button>
    </div>
  );
}
