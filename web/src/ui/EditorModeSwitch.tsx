import { useT } from '../i18n';
import type { EditorMode } from '../shell/prefs';

/** Writing | Code segmented control in the header (on phones the ⋯ menu has it). */
export function EditorModeSwitch({ mode, onMode }: { mode: EditorMode; onMode: (mode: EditorMode) => void }) {
  const m = useT().editor;
  return (
    <div class="segmented mode-switch" role="group" aria-label={m.mode}>
      <button type="button" aria-pressed={mode === 'writing'} onClick={() => onMode('writing')}>
        {m.writing}
      </button>
      <button type="button" aria-pressed={mode === 'code'} onClick={() => onMode('code')}>
        {m.code}
      </button>
    </div>
  );
}
