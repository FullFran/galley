import { useEffect, useMemo, useState } from 'preact/hooks';
import { AuthRequiredError, type ChangedFile, type Proposal, type RepoGateway, type Repository } from '../domain';
import type { TeamGateway } from '../github/team';
import { useT } from '../i18n';
import { formatRoute, repoRoute } from '../shell/route';
import { CODEOWNERS_PATHS, ownersOf, parseCodeowners } from '../team/codeowners';
import { ownerLogins } from '../team/sections';
import { AskDialog } from '../ui/team/TeamDialogs';
import { today } from './useTeam';
import '../ui/team/team.css';

// Owners and asks on a proposal (lazy): "Owner: @x" for each changed file
// that CODEOWNERS on the default branch assigns, one click to ask those
// owners to review, and "Ask someone…" with a due date.

export interface ProposalTeamProps {
  repos: RepoGateway;
  team?: TeamGateway;
  repo: Repository;
  proposal: Proposal;
  files: ChangedFile[];
  /** Open proposal and push access: review requests are allowed. */
  canRequest: boolean;
  busy: boolean;
  onRequestOwners: (logins: string[]) => void;
  onNotice: (text: string, error?: boolean) => void;
  onAuthRequired: () => void;
}

async function readCodeowners(repos: RepoGateway, repo: Repository): Promise<string> {
  // GitHub uses the first file it finds, in this order.
  for (const path of CODEOWNERS_PATHS) {
    try {
      return await repos.readFile(repo, path, repo.defaultBranch);
    } catch (err) {
      if (err instanceof AuthRequiredError) throw err;
    }
  }
  return '';
}

export function ProposalTeam({ repos, team, repo, proposal, files, canRequest, busy, onRequestOwners, onNotice, onAuthRequired }: ProposalTeamProps) {
  const m = useT().team;
  const [text, setText] = useState<string>();
  const [asking, setAsking] = useState(false);
  const [people, setPeople] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    readCodeowners(repos, repo).then(
      (t) => active && setText(t),
      (err: unknown) => (err instanceof AuthRequiredError ? onAuthRequired() : active && setText('')),
    );
    return () => {
      active = false;
    };
  }, [repos, repo.id]);

  const owned = useMemo(() => {
    const rules = parseCodeowners(text ?? '');
    return files.map((f) => ({ path: f.path, owners: ownersOf(rules, f.path) })).filter((f) => f.owners.length > 0);
  }, [text, files]);
  const requested = new Set(proposal.requestedReviewers.map((p) => p.login.toLowerCase()));
  const logins = ownerLogins(
    owned.flatMap((f) => f.owners),
    proposal.author?.login,
  ).filter((l) => !requested.has(l.toLowerCase()));
  const onlyTeams = owned.some((f) => f.owners.some((o) => !o.startsWith('@') || o.includes('/')));

  const openAsk = () => {
    setError(undefined);
    setAsking(true);
    if (team && people.length === 0) team.assignees(repo).then(setPeople, () => undefined);
  };
  const sendAsk = async (form: { assignee: string; due: string; note: string }) => {
    if (!team) return;
    setSending(true);
    try {
      const here = typeof window === 'undefined' ? '' : `${window.location.origin}${window.location.pathname}`;
      const galleyUrl = `${here}${formatRoute({ name: 'proposals', ...repoRoute(repo.fullName), number: proposal.number })}`;
      await team.createAsk(repo, { what: proposal.title, galleyUrl, githubUrl: proposal.htmlUrl, ...form });
      setAsking(false);
      onNotice(m.created(form.assignee));
    } catch (err) {
      if (err instanceof AuthRequiredError) onAuthRequired();
      else setError(m.askFailed);
    } finally {
      setSending(false);
    }
  };

  if (owned.length === 0 && !team) return null;
  return (
    <section class="side-block owners-box" aria-labelledby="owners-heading">
      <h3 id="owners-heading">{m.sectionOwners}</h3>
      {owned.length > 0 && (
        <ul>
          {owned.map((f) => (
            <li key={f.path}>
              <span class="muted">{f.path}</span>
              <br />
              {m.ownerLine(f.owners.length, f.owners.join(', '))}
            </li>
          ))}
        </ul>
      )}
      {canRequest && logins.length > 0 && (
        <button type="button" disabled={busy} onClick={() => onRequestOwners(logins)}>
          {m.askOwners}
        </button>
      )}
      {onlyTeams && <p class="muted">{m.teamsOnGitHub}</p>}
      {team && (
        <p>
          <button type="button" onClick={openAsk}>
            {m.askSomeone}
          </button>
        </p>
      )}
      {asking && (
        <AskDialog what={proposal.title} people={people} today={today()} busy={sending} error={error} onSubmit={(f) => void sendAsk(f)} onClose={() => setAsking(false)} />
      )}
    </section>
  );
}
