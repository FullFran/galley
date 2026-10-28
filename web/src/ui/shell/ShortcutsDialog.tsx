import { useT } from '../../i18n';
import { SHORTCUTS, shortcutLabel } from '../../shell/shortcuts';
import { Modal } from './Modal';

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const m = t.shortcuts;
  return (
    <Modal open={open} onClose={onClose} labelledBy="shortcuts-title" class="shortcuts-dialog">
      <h2 id="shortcuts-title">{m.title}</h2>
      <dl class="shortcut-list">
        {SHORTCUTS.map((s) => (
          <div key={s.action} class="shortcut-row">
            <dt>{shortcutLabel(s.action, t)}</dt>
            <dd>
              {s.keys.map((k, i) => (
                <span key={k}>
                  {i > 0 && <span aria-hidden="true">+</span>}
                  <kbd>{k}</kbd>
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
      <p class="muted">{m.mac}</p>
      <div class="actions">
        <button type="button" class="primary" onClick={onClose}>
          {m.close}
        </button>
      </div>
    </Modal>
  );
}
