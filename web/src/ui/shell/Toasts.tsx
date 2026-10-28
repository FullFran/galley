import type { ComponentChildren } from 'preact';
import { useT } from '../../i18n';
import { Icon } from './icons';

/** Non-modal notices over the content, so they never push the editor down. */
export function Toasts({ children }: { children?: ComponentChildren }) {
  return (
    <div class="toasts" aria-label={useT().shell.notifications}>
      {children}
    </div>
  );
}

export function Toast({ children, onDismiss, tone = 'neutral' }: { children: ComponentChildren; onDismiss?: () => void; tone?: 'neutral' | 'ok' | 'warn' | 'danger' }) {
  const t = useT();
  return (
    <div class={`toast toast-${tone}`}>
      <div class="toast-body">{children}</div>
      {onDismiss && (
        <button type="button" class="icon-button" aria-label={t.shell.dismiss} onClick={onDismiss}>
          <Icon name="close" />
        </button>
      )}
    </div>
  );
}
