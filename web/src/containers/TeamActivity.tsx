import { useCallback, useEffect, useState } from 'preact/hooks';
import { AuthRequiredError, type Repository } from '../domain';
import type { TeamGateway } from '../github/team';
import { useT } from '../i18n';
import type { ActivityRow } from '../team/activity';
import { Skeleton } from '../ui/shell/Skeleton';
import '../ui/team/team.css';

// Team activity (Admin area, lazy): counts per person over the last 7 days,
// alphabetical, with neutral wording. No totals, ranks or highlights.

export interface TeamActivityProps {
  team: TeamGateway;
  repo: Repository;
  onAuthRequired: () => void;
}

export function TeamActivity({ team, repo, onAuthRequired }: TeamActivityProps) {
  const t = useT();
  const m = t.team;
  const [data, setData] = useState<{ since: Date; rows: ActivityRow[] }>();
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setFailed(false);
    team.activity(repo).then(setData, (err: unknown) => {
      if (err instanceof AuthRequiredError) onAuthRequired();
      else setFailed(true);
    });
  }, [team, repo, onAuthRequired]);
  useEffect(load, [load]);

  const date = (d: Date) => d.toLocaleDateString(t.meta.lang, { day: 'numeric', month: 'long' });
  return (
    <div class="team-activity" data-testid="team-activity">
      <h2>{m.activityTitle}</h2>
      <p class="muted">{m.activityLead}</p>
      {failed ? (
        <div class="notice notice-danger" role="alert">
          <p>{m.activityFailed}</p>
          <button type="button" onClick={load}>
            {m.retry}
          </button>
        </div>
      ) : !data ? (
        <Skeleton lines={5} label={m.activityLoading} />
      ) : data.rows.length === 0 ? (
        <p class="muted">{m.activityEmpty}</p>
      ) : (
        <>
          <p class="muted">{m.since(date(data.since))}</p>
          <div class="activity-table-wrap">
            <table class="activity-table">
              <thead>
                <tr>
                  <th scope="col">{m.person_}</th>
                  <th scope="col">{m.commits}</th>
                  <th scope="col">{m.opened}</th>
                  <th scope="col">{m.merged}</th>
                  <th scope="col">{m.reviews}</th>
                  <th scope="col">{m.commentsCol}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.login}>
                    <th scope="row">{r.login}</th>
                    <td>{r.commits}</td>
                    <td>{r.opened}</td>
                    <td>{r.merged}</td>
                    <td>{r.reviews}</td>
                    <td>{r.comments}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p class="muted">{m.activityLimits}</p>
        </>
      )}
    </div>
  );
}
