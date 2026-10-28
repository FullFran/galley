import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { AuthRequiredError, NotFoundError, PermissionError, TransientError } from '../../domain';
import { RateLimitedError } from '../../domain/comments';
import { useT, useTRef, type Messages } from '../../i18n';
import { ConfirmSelfError, DuplicateEntryError, type DraftShare } from '../../admin/api';
import { createHttpAdminGateway, type AdminGateway, type AdminPerson, type AllowEntry, type AuditEntry, type SharedDraftContent } from '../../admin/http';
import { confirmRevoke, startRevoke, validateAllowInput, type AllowValidation, type RevokeState } from '../../admin/model';
import type { PanelTabId } from '../../shell/adminTabs';
import { Skeleton } from '../shell/Skeleton';
import { AccessView, ActivityView, PeopleView, RevokeDialog, SharedDraftsView, SharedDraftViewer } from './views';

// The admin panel (C6), loaded on demand when an admin opens one of its tabs,
// so co-authors never download it. Containers: each tab loads its own data.

export interface AdminPanelsProps {
  tab: PanelTabId;
  repoId: number;
  /** Your login, to mark your own row and to confirm revoking yourself. */
  me?: string;
  /** Defaults to the galley API from the build's VITE_API_BASE. */
  gateway?: AdminGateway;
  onOpenProposals: (login: string) => void;
  /** Opens a shared draft's text as the admin's own unsaved edit of that file. */
  onCopyIntoDraft: (path: string, content: string) => void;
  onAuthRequired: () => void;
}

export function describeAdminError(err: unknown, t: Messages): string {
  const m = t.adminPanel.errors;
  if (err instanceof RateLimitedError) return m.rateLimited(err.retryAfterSeconds);
  if (err instanceof PermissionError) return m.forbidden;
  if (err instanceof NotFoundError) return m.notFound;
  if (err instanceof DuplicateEntryError) return m.duplicate;
  if (err instanceof ConfirmSelfError) return m.confirmSelf;
  if (err instanceof TransientError) return m.unavailable;
  return m.generic;
}

type Load<T> = { state: 'loading' } | { state: 'ready'; data: T } | { state: 'failed'; message: string };

/** Loads once per key; `reload` asks again. Sign-in errors go to `onAuthRequired`. */
function useLoad<T>(fetcher: () => Promise<T>, onAuthRequired: () => void, key: string) {
  const tRef = useTRef();
  const [load, setLoad] = useState<Load<T>>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoad({ state: 'loading' });
    fetcher().then(
      (data) => active && setLoad({ state: 'ready', data }),
      (err: unknown) => {
        if (!active) return;
        if (err instanceof AuthRequiredError) onAuthRequired();
        else setLoad({ state: 'failed', message: describeAdminError(err, tRef.current) });
      },
    );
    return () => {
      active = false;
    };
  }, [key, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { load, setLoad, reload };
}

function Failed({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div class="notice notice-danger" role="alert">
      <p>{message}</p>
      <button type="button" onClick={onRetry}>
        {t.adminPanel.retry}
      </button>
    </div>
  );
}

const Loading = () => <Skeleton lines={4} label={useT().adminPanel.loading} />;

export function AdminPanels(props: AdminPanelsProps) {
  const gateway = useMemo(() => props.gateway ?? createHttpAdminGateway(), [props.gateway]);
  const shared = { ...props, gateway };
  switch (props.tab) {
    case 'people':
      return <PeopleTab {...shared} />;
    case 'access':
      return <AccessTab {...shared} />;
    case 'shared':
      return <SharedTab {...shared} />;
    case 'activity':
      return <ActivityTab {...shared} />;
  }
}

type TabProps = AdminPanelsProps & { gateway: AdminGateway };

function PeopleTab({ gateway, repoId, me, onOpenProposals, onAuthRequired }: TabProps) {
  const t = useT();
  const { load, reload } = useLoad(() => gateway.people(repoId), onAuthRequired, `people:${repoId}`);
  const [revoke, setRevoke] = useState<RevokeState>({ step: 'idle' });
  const [done, setDone] = useState<string>();
  const confirm = async () => {
    if (revoke.step !== 'confirm' && revoke.step !== 'failed') return;
    setRevoke({ step: 'busy', person: revoke.person, self: revoke.self });
    const next = await confirmRevoke(gateway, repoId, revoke);
    if (next.step === 'failed' && next.error instanceof AuthRequiredError) return onAuthRequired();
    if (next.step === 'done') {
      setRevoke({ step: 'idle' });
      // Your own sessions are gone: sign in again.
      if (next.self) return onAuthRequired();
      setDone(t.adminPanel.revoke.done(next.login));
      reload();
      return;
    }
    setRevoke(next);
  };
  if (load.state === 'loading') return <Loading />;
  if (load.state === 'failed') return <Failed message={load.message} onRetry={reload} />;
  return (
    <>
      {done && (
        <p class="notice notice-ok" role="status">
          {done}
        </p>
      )}
      <PeopleView
        people={load.data}
        me={me}
        onRevoke={(p) => {
          setDone(undefined);
          setRevoke(startRevoke(p, me));
        }}
        onOpenProposals={onOpenProposals}
      />
      <RevokeDialog
        state={revoke}
        error={revoke.step === 'failed' ? describeAdminError(revoke.error, t) : undefined}
        onConfirm={() => void confirm()}
        onCancel={() => setRevoke({ step: 'idle' })}
      />
    </>
  );
}

function AccessTab({ gateway, repoId, onAuthRequired }: TabProps) {
  const t = useT();
  const { load, setLoad, reload } = useLoad(
    () => Promise.all([gateway.allowlist(repoId), gateway.people(repoId).catch(() => [] as AdminPerson[])]),
    onAuthRequired,
    `access:${repoId}`,
  );
  const [login, setLogin] = useState('');
  const [githubId, setGithubId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Extract<AllowValidation, { ok: false }>['reason'] | { message: string }>();
  if (load.state === 'loading') return <Loading />;
  if (load.state === 'failed') return <Failed message={load.message} onRetry={reload} />;
  const [entries, people] = load.data;
  const update = (next: AllowEntry[]) => setLoad({ state: 'ready', data: [next, people] });
  const fail = (err: unknown) => (err instanceof AuthRequiredError ? onAuthRequired() : setError({ message: describeAdminError(err, t) }));
  const add = async () => {
    const check = validateAllowInput(login, githubId, entries);
    if (!check.ok) return setError(check.reason);
    setError(undefined);
    setBusy(true);
    try {
      const entry = await gateway.allow(repoId, check.input);
      update([...entries, entry]);
      setLogin('');
      setGithubId('');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (entry: AllowEntry) => {
    setError(undefined);
    setBusy(true);
    try {
      await gateway.disallow(repoId, entry.id);
      update(entries.filter((e) => e.id !== entry.id));
    } catch (err) {
      if (err instanceof NotFoundError) update(entries.filter((e) => e.id !== entry.id));
      else fail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AccessView
      entries={entries}
      people={people}
      login={login}
      githubId={githubId}
      busy={busy}
      error={error}
      onLogin={setLogin}
      onGithubId={setGithubId}
      onAdd={() => void add()}
      onRemove={(e) => void remove(e)}
    />
  );
}

function SharedTab({ gateway, repoId, onAuthRequired, onCopyIntoDraft }: TabProps) {
  const t = useT();
  const { load, reload } = useLoad(() => gateway.sharedDrafts(repoId), onAuthRequired, `shared:${repoId}`);
  const [open, setOpen] = useState<SharedDraftContent>();
  const [viewError, setViewError] = useState<string>();
  const view = async (share: DraftShare) => {
    setViewError(undefined);
    try {
      setOpen(await gateway.sharedDraft(repoId, share.id));
    } catch (err) {
      if (err instanceof AuthRequiredError) return onAuthRequired();
      setViewError(describeAdminError(err, t));
      if (err instanceof NotFoundError) reload();
    }
  };
  if (open) {
    return <SharedDraftViewer draft={open} onClose={() => setOpen(undefined)} onCopy={() => onCopyIntoDraft(open.path, open.content)} />;
  }
  if (load.state === 'loading') return <Loading />;
  if (load.state === 'failed') return <Failed message={load.message} onRetry={reload} />;
  return (
    <>
      {viewError && (
        <p class="notice notice-danger" role="alert">
          {viewError}
        </p>
      )}
      <SharedDraftsView shares={load.data} onView={(s) => void view(s)} />
    </>
  );
}

function ActivityTab({ gateway, repoId, onAuthRequired }: TabProps) {
  const { load, reload } = useLoad<AuditEntry[]>(() => gateway.audit(repoId), onAuthRequired, `audit:${repoId}`);
  const [action, setAction] = useState('');
  if (load.state === 'loading') return <Loading />;
  if (load.state === 'failed') return <Failed message={load.message} onRetry={reload} />;
  return <ActivityView entries={load.data} action={action} onAction={setAction} />;
}
