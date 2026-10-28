import { useEffect, useRef } from 'preact/hooks';
import { useT } from '../../i18n';
import { VERSION } from '../../shell/credits';
import { Credit } from './Credit';

export interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Modal About dialog on the native <dialog>: focus stays inside, Escape closes it. */
export function AboutDialog({ open, onClose }: AboutDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const m = useT().about;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={ref} class="dialog" aria-labelledby="about-title" onClose={onClose}>
      <h2 id="about-title">{m.title}</h2>
      <p>{m.summary}</p>
      <p class="muted">
        {m.version(VERSION)} · {m.licence}
      </p>
      <Credit />
      <h3>{m.creditsTitle}</h3>
      <ul class="about-credits">
        {m.credits.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div class="actions">
        <button type="button" class="primary" onClick={onClose}>
          {m.close}
        </button>
      </div>
    </dialog>
  );
}
