import { RejectedError, type Repository } from '../domain';
import { LOGIN } from '../shell/route';
import { aggregateActivity, weekStart, type ActivityRow } from '../team/activity';
import {
  ASK_LABEL,
  ASK_LABEL_COLOR,
  ASK_LABEL_DESCRIPTION,
  askIssue,
  isDueDate,
  mergeAsks,
  milestoneDue,
  milestoneTitle,
  type Ask,
  type AskInput,
  type GhIssue,
} from '../team/asks';
import { GitHubClient, type TokenSource } from './client';
import { repoBase, seg } from './git';

// Team management endpoints and the GitHub App permission each one needs
// (user access token; docs.github.com, "Permissions required for GitHub Apps"):
//   labels/{name} (GET)                          Issues: read
//   labels (POST)                                Issues: write
//   milestones (GET)                             Issues: read
//   milestones (POST)                            Issues: write
//   issues (POST), issues/{n} (PATCH)            Issues: write
//   issues?labels=… (GET), assignees (GET)       Issues: read
//   issues/comments (GET)                        Issues: read
//   branches, commits (GET)                      Contents: read
//   pulls, pulls/comments, pulls/{n}/reviews     Pull requests: read
// GitHub keeps the assignee and the milestone of a new issue only when the
// person creating it has push access; otherwise they are silently dropped.

export interface TeamGateway {
  /** Creates the ask issue (label and milestone created or reused). */
  createAsk(repo: Repository, input: AskInput): Promise<{ number: number; url: string }>;
  /** Open asks assigned to `me` or opened by `me`. */
  myAsks(repo: Repository, me: string): Promise<Ask[]>;
  closeAsk(repo: Repository, number: number): Promise<void>;
  /** People who can be assigned (push access), for the ask dialog. */
  assignees(repo: Repository): Promise<string[]>;
  /** Activity per person in the last 7 days. */
  activity(repo: Repository): Promise<{ since: Date; rows: ActivityRow[] }>;
}

export interface GitHubTeamGatewayOptions {
  tokens: TokenSource;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

/** At most this many branches and proposals are read for the activity view. */
const MAX_BRANCHES = 30;
const MAX_REVIEWED_PULLS = 30;

interface GhCommit {
  sha: string;
  author?: { login: string } | null;
  commit?: { author?: { date?: string } | null };
}
interface GhPull {
  number: number;
  user?: { login: string } | null;
  created_at?: string;
  merged_at?: string | null;
  updated_at?: string;
}
interface GhComment {
  id: number;
  user?: { login: string } | null;
  created_at?: string;
}

export function createGitHubTeamGateway(options: GitHubTeamGatewayOptions): TeamGateway {
  const gh = new GitHubClient(options.tokens, options.fetch ?? globalThis.fetch.bind(globalThis));
  const now = options.now ?? (() => new Date());
  const list = <T>(repo: Repository, path: string) => gh.paginate<T[], T>(path, (page) => (Array.isArray(page) ? page : []), repo.id);

  const ensureLabel = async (repo: Repository) => {
    const found = await gh.request(`${repoBase(repo)}/labels/${seg(ASK_LABEL)}`, { repositoryId: repo.id, allow: [404] });
    if (found.status !== 404) return;
    // 422: someone created it meanwhile.
    await gh.request(`${repoBase(repo)}/labels`, {
      repositoryId: repo.id,
      method: 'POST',
      body: { name: ASK_LABEL, color: ASK_LABEL_COLOR, description: ASK_LABEL_DESCRIPTION },
      allow: [422],
    });
  };

  const findMilestone = async (repo: Repository, title: string) => {
    const all = await list<{ number: number; title: string }>(repo, `${repoBase(repo)}/milestones?state=all&per_page=100`);
    return all.find((m) => m.title === title)?.number;
  };

  const ensureMilestone = async (repo: Repository, due: string) => {
    const title = milestoneTitle(due);
    const existing = await findMilestone(repo, title);
    if (existing !== undefined) return existing;
    const res = await gh.request<{ number: number }>(`${repoBase(repo)}/milestones`, {
      repositoryId: repo.id,
      method: 'POST',
      body: { title, due_on: milestoneDue(due) },
      allow: [422],
    });
    if (res.status !== 422) return res.data.number;
    return findMilestone(repo, title);
  };

  return {
    async createAsk(repo, input) {
      if (!isDueDate(input.due)) throw new RejectedError('invalid due date');
      if (!LOGIN.test(input.assignee)) throw new RejectedError('invalid login');
      await ensureLabel(repo);
      const milestone = await ensureMilestone(repo, input.due);
      const { data } = await gh.request<{ number: number; html_url: string }>(`${repoBase(repo)}/issues`, {
        repositoryId: repo.id,
        method: 'POST',
        body: askIssue({ ...input, milestone }),
      });
      return { number: data.number, url: data.html_url };
    },

    async myAsks(repo, me) {
      if (!LOGIN.test(me)) return [];
      const q = `${repoBase(repo)}/issues?labels=${seg(ASK_LABEL)}&state=open`;
      const [assigned, created] = await Promise.all([
        list<GhIssue>(repo, `${q}&assignee=${seg(me)}&per_page=100`),
        list<GhIssue>(repo, `${q}&creator=${seg(me)}&per_page=100`),
      ]);
      return mergeAsks(assigned, created, me, now());
    },

    async closeAsk(repo, number) {
      await gh.request(`${repoBase(repo)}/issues/${number}`, {
        repositoryId: repo.id,
        method: 'PATCH',
        body: { state: 'closed', state_reason: 'completed' },
      });
    },

    async assignees(repo) {
      const users = await list<{ login: string }>(repo, `${repoBase(repo)}/assignees?per_page=100`);
      return users.map((u) => u.login);
    },

    async activity(repo) {
      const since = weekStart(now());
      const iso = encodeURIComponent(since.toISOString());
      const base = repoBase(repo);
      const get = async <T>(path: string) => {
        const res = await gh.request<T[]>(path, { repositoryId: repo.id });
        return Array.isArray(res.data) ? res.data : [];
      };
      const branches = (await list<{ name: string }>(repo, `${base}/branches?per_page=100`))
        .map((b) => b.name)
        .filter((n) => n === repo.defaultBranch || n.startsWith('galley/'))
        .slice(0, MAX_BRANCHES);
      const [commitLists, pulls, reviewComments, issueComments] = await Promise.all([
        Promise.all(branches.map((b) => get<GhCommit>(`${base}/commits?sha=${seg(b)}&since=${iso}&per_page=100`))),
        get<GhPull>(`${base}/pulls?state=all&sort=updated&direction=desc&per_page=100`),
        get<GhComment>(`${base}/pulls/comments?since=${iso}&per_page=100`),
        get<GhComment>(`${base}/issues/comments?since=${iso}&per_page=100`),
      ]);
      const recent = pulls.filter((p) => p.updated_at && new Date(p.updated_at) >= since).slice(0, MAX_REVIEWED_PULLS);
      const reviewLists = await Promise.all(
        recent.map((p) => get<{ user?: { login: string } | null; submitted_at?: string; state?: string }>(`${base}/pulls/${p.number}/reviews?per_page=100`)),
      );
      const rows = aggregateActivity(
        {
          commits: commitLists.flat().map((c) => ({ sha: c.sha, login: c.author?.login, date: c.commit?.author?.date ?? undefined })),
          pulls: pulls.map((p) => ({ number: p.number, login: p.user?.login, createdAt: p.created_at, mergedAt: p.merged_at ?? undefined })),
          reviews: reviewLists.flat().filter((r) => r.state !== 'PENDING').map((r) => ({ login: r.user?.login, submittedAt: r.submitted_at })),
          // Review comments and conversation comments have separate ids.
          comments: [
            ...reviewComments.map((c) => ({ id: c.id, login: c.user?.login, createdAt: c.created_at })),
            ...issueComments.map((c) => ({ id: -c.id, login: c.user?.login, createdAt: c.created_at })),
          ],
        },
        since,
      );
      return { since, rows };
    },
  };
}
