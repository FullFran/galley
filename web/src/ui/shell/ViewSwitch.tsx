import { useT } from '../../i18n';

export type PaneView = 'edit' | 'preview';

/** Edit | Preview segmented control for screens with room for one pane. */
export function ViewSwitch({ view, onView }: { view: PaneView; onView: (view: PaneView) => void }) {
  const m = useT().workspace;
  return (
    <div class="segmented view-switch" role="group" aria-label={m.show}>
      <button type="button" aria-pressed={view === 'edit'} onClick={() => onView('edit')}>
        {m.edit}
      </button>
      <button type="button" aria-pressed={view === 'preview'} onClick={() => onView('preview')}>
        {m.preview}
      </button>
    </div>
  );
}
