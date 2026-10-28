import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { NotFoundError, type FileChange, type RepoGateway, type Repository } from '../domain';
import type { HistoryGateway } from '../github/history';
import { lastVisitBanner, localStore, readLastSeen, writeLastSeen, type LastVisitBanner } from '../history/lastVisit';
import { applyRestore, type PreparedChange, type Restored } from '../history/restore';
import type { Buffers } from '../workspace/model';
import { useT } from '../i18n';
import { Icon } from '../ui/shell/icons';

// The parts of History the workspace needs before the History screen loads:
// restored changes waiting for the next save, and the last-visit banner.

interface RestoreState {
  /** Binary files and deletions for the next save (text lives in the buffers). */
  pending: FileChange[];
  /** Restored files the working head does not have, shown in the file list. */
  created: string[];
  /** Suggested save note. */
  message?: string;
}

const EMPTY: RestoreState = { pending: [], created: [] };

export function useRestore() {
  const [state, setState] = useState<RestoreState>(EMPTY);
  const ref = useRef(state);
  ref.current = state;
  const apply = useCallback((buffers: Buffers, changes: PreparedChange[], files: readonly string[], message: string): Restored => {
    const result = applyRestore(buffers, ref.current.pending, changes, files);
    const deleted = new Set(result.deleted);
    const removed = new Set(changes.filter((c) => c.kind !== 'text').map((c) => c.path));
    const created = [...new Set([...ref.current.created.filter((p) => !removed.has(p)), ...result.created])].filter((p) => !deleted.has(p)).sort();
    const next = { pending: result.pending, created, message };
    ref.current = next;
    setState(next);
    return result;
  }, []);
  const committed = useCallback(() => {
    ref.current = EMPTY;
    setState(EMPTY);
  }, []);
  const deleted = state.pending.filter((c) => c.delete).map((c) => c.path);
  return { pending: state.pending, created: state.created, deleted, message: state.message, apply, committed };
}

/**
 * Compares the default-branch head with the one this person last saw here.
 * The first visit only remembers the head; a remembered head GitHub no longer
 * knows (history rewritten) is replaced silently.
 */
export function useLastVisit(history: HistoryGateway | undefined, gateway: RepoGateway, repo: Repository, login: string | undefined) {
  const [banner, setBanner] = useState<LastVisitBanner>();
  useEffect(() => {
    setBanner(undefined);
    if (!history || !login) return;
    let active = true;
    void (async () => {
      const head = await gateway.defaultHead(repo);
      const since = readLastSeen(localStore(), login, repo.fullName);
      if (!since) return writeLastSeen(localStore(), login, repo.fullName, head);
      if (since === head) return;
      try {
        const diff = await history.compare(repo, since, head);
        if (active) setBanner(lastVisitBanner(since, head, diff.commits));
      } catch (err) {
        if (err instanceof NotFoundError) writeLastSeen(localStore(), login, repo.fullName, head);
      }
    })().catch(() => undefined);
    return () => {
      active = false;
    };
  }, [history, gateway, repo, login]);
  const markSeen = useCallback(
    (head: string) => {
      if (login) writeLastSeen(localStore(), login, repo.fullName, head);
      setBanner(undefined);
    },
    [login, repo.fullName],
  );
  return { banner, markSeen };
}

export function LastVisitBannerView({ banner, onSee, onSeen }: { banner: LastVisitBanner; onSee: () => void; onSeen: () => void }) {
  const t = useT().history.since;
  return (
    <div class="line-banner line-banner-info" role="status" data-testid="last-visit">
      <Icon name="history" class="line-banner-icon" />
      <p class="line-banner-text">{t.banner(banner.count)}</p>
      <button type="button" class="line-banner-action" onClick={onSee}>
        {t.see}
      </button>
      <button type="button" class="line-banner-action" onClick={onSeen}>
        {t.seen}
      </button>
    </div>
  );
}
