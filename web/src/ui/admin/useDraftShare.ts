import { useCallback, useEffect, useState } from 'preact/hooks';
import { AuthRequiredError } from '../../domain';
import { formatDateTime } from '../../i18n/format';
import type { Messages } from '../../i18n';
import type { DraftSharesGateway } from '../../admin/api';
import { shareStatus, toggleShare, type ShareStatus } from '../../admin/model';
import { shareMenuItem } from './shareMenu';

// The owner's side of draft sharing for the open file: its status (from your
// grants and your server drafts, metadata only) and the ⋯ menu entry that
// shares it with the repository's admins for 24 hours or stops sharing.

export interface DraftShareOptions {
  gateway?: DraftSharesGateway;
  repoId: number;
  path?: string;
  t: Messages;
  notify: (message: string) => void;
  onAuthRequired: () => void;
}

export function useDraftShare({ gateway, repoId, path, t, notify, onAuthRequired }: DraftShareOptions) {
  const [status, setStatus] = useState<ShareStatus>({ kind: 'unavailable' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStatus({ kind: 'unavailable' });
    if (!gateway || !path) return;
    let active = true;
    setStatus({ kind: 'loading' });
    Promise.all([gateway.list(repoId), gateway.hasDraft(repoId, path)]).then(
      ([shares, hasDraft]) => active && setStatus(shareStatus(path, hasDraft, shares)),
      // No galley API, or not allowed here: the entry is not offered.
      () => active && setStatus({ kind: 'unavailable' }),
    );
    return () => {
      active = false;
    };
  }, [gateway, repoId, path]);

  const toggle = useCallback(async () => {
    if (!gateway || !path || busy) return;
    setBusy(true);
    try {
      const out = await toggleShare(gateway, repoId, path, status);
      setStatus(out.status);
      const m = t.shareDraft;
      if (out.notice === 'shared' && out.status.kind === 'on') notify(m.shared(formatDateTime(out.status.expiresAt, t.meta.lang)));
      else if (out.notice === 'stopped') notify(m.stopped);
      else if (out.notice === 'no-draft') notify(m.noDraft);
      else if (out.notice === 'forbidden') notify(m.forbidden);
      else notify(m.failed);
    } catch (err) {
      if (err instanceof AuthRequiredError) onAuthRequired();
      else notify(t.shareDraft.failed);
    } finally {
      setBusy(false);
    }
  }, [gateway, repoId, path, status, busy, t, notify, onAuthRequired]);

  const item = busy ? undefined : shareMenuItem(status, t);
  return { status, item: item && { label: item.label, onSelect: () => void toggle() } };
}
