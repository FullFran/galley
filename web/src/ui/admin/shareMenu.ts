import type { Messages } from '../../i18n';
import { remaining, type ShareStatus } from '../../admin/model';

/** The editor ⋯ menu entry for sharing the open draft; none while unavailable. */
export function shareMenuItem(status: ShareStatus, t: Messages, now = Date.now()): { label: string } | undefined {
  const m = t.shareDraft;
  switch (status.kind) {
    case 'off':
    case 'no-draft':
      return { label: m.share };
    case 'on': {
      const left = remaining(status.expiresAt, now);
      return { label: left ? m.stop(m.left(left.hours, left.minutes)) : m.share };
    }
    default:
      return undefined;
  }
}
