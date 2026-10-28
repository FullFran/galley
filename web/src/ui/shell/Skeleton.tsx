import { useT } from '../../i18n';

export interface SkeletonProps {
  /** Placeholder rows; `list` rows are taller, like repository or proposal rows. */
  lines?: number;
  variant?: 'text' | 'list' | 'pane';
  /** Read by screen readers instead of the placeholder shapes. */
  label?: string;
}

/** Reserves the space of content that is loading, with one status for assistive tech. */
export function Skeleton({ lines = 3, variant = 'text', label }: SkeletonProps) {
  const t = useT();
  const name = label ?? t.app.loading;
  return (
    <div class={`skeleton skeleton-${variant}`} role="status" aria-label={name}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} class="skeleton-bar" aria-hidden="true" />
      ))}
    </div>
  );
}
