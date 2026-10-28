import { useCallback, useEffect, useState } from 'preact/hooks';
import { AuthRequiredError, type Repository } from '../domain';
import type { TeamGateway } from '../github/team';
import { useT } from '../i18n';
import type { Ask } from '../team/asks';
import { Skeleton } from '../ui/shell/Skeleton';
import '../ui/team/team.css';

// My asks (a lazy screen in the Review group): open `galley-ask` issues
// assigned to me or opened by me, soonest due first, overdue highlighted.

export interface MyAsksProps {
  team: TeamGateway;
  repo: Repository;
  me?: string;
  onAuthRequired: () => void;
}

export function MyAsks({ team, repo, me, onAuthRequired }: MyAsksProps) {
  const m = useT().team;
  const [asks, setAsks] = useState<Ask[]>();
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState<number>();

  const load = useCallback(() => {
    if (!me) return;
    setFailed(false);
    team.myAsks(repo, me).then(setAsks, (err: unknown) => {
      if (err instanceof AuthRequiredError) onAuthRequired();
      else setFailed(true);
    });
  }, [team, repo, me, onAuthRequired]);
  useEffect(load, [load]);

  const done = async (ask: Ask) => {
    setBusy(ask.number);
    try {
      await team.closeAsk(repo, ask.number);
      setAsks((list) => list?.filter((a) => a.number !== ask.number));
      setNotice(m.closed(ask.title));
    } catch (err) {
      if (err instanceof AuthRequiredError) onAuthRequired();
      else setNotice(m.asksFailed);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div class="page page-wide my-asks" data-testid="my-asks">
      <h1>{m.asksTitle}</h1>
      <p class="muted">{m.asksLead}</p>
      {notice && (
        <p class="notice" role="status">
          {notice}
        </p>
      )}
      {failed ? (
        <div class="notice notice-danger" role="alert">
          <p>{m.asksFailed}</p>
          <button type="button" onClick={load}>
            {m.retry}
          </button>
        </div>
      ) : !asks ? (
        <Skeleton lines={4} label={m.asksLoading} />
      ) : asks.length === 0 ? (
        <p class="muted">{m.asksEmpty}</p>
      ) : (
        <ul class="asks-list">
          {asks.map((a) => (
            <li key={a.number} class={a.overdue ? 'ask-row ask-row-overdue' : 'ask-row'}>
              <div class="ask-main">
                <div class="ask-title">{a.title}</div>
                <div class="ask-meta">
                  {a.toMe && a.creator ? m.toYou(a.creator) : m.byYou(a.assignees.join(', '))}
                  {' · '}
                  <span class={a.overdue ? 'ask-due-overdue' : undefined}>
                    {a.due ? m.dueOn(a.due) : m.noDue}
                    {a.overdue && ` · ${m.overdue}`}
                  </span>
                  {' · '}
                  {m.comments(a.comments)}
                </div>
              </div>
              <div class="ask-actions">
                <a href={a.url} target="_blank" rel="noopener noreferrer">
                  {m.comment}
                </a>
                <button type="button" title={m.doneHint} disabled={busy === a.number} onClick={() => void done(a)}>
                  {m.done}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
