import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** id of the heading inside, for aria-labelledby. */
  labelledBy: string;
  class?: string;
  children: ComponentChildren;
}

/** Native modal <dialog>: focus stays inside, Escape closes, focus returns to the opener. */
export function Modal({ open, onClose, labelledBy, class: className, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} class={className ? `dialog ${className}` : 'dialog'} aria-labelledby={labelledBy} onClose={onClose}>
      {children}
    </dialog>
  );
}
