import { useT } from '../../i18n';
import type { ViewAs } from '../../config/viewAs';

/** Admins only: switch the file list between every file and the co-author view. */
export function ViewAsSwitch({ mode, onMode }: { mode: ViewAs; onMode: (mode: ViewAs) => void }) {
  const m = useT().files;
  return (
    <div class="view-as">
      <div class="segmented" role="group" aria-label={m.viewLabel}>
        <button type="button" aria-pressed={mode === 'all'} onClick={() => onMode('all')}>
          {m.viewAll}
        </button>
        <button type="button" aria-pressed={mode === 'coauthor'} onClick={() => onMode('coauthor')}>
          {m.viewCoauthor}
        </button>
      </div>
      <p class="muted panel-note" role="status">
        {mode === 'all' ? m.modeAll : m.modeCoauthor}
      </p>
    </div>
  );
}
