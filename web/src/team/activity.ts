// Weekly team activity for admins: what each person did in the last 7 days,
// counted from GitHub. Rows are alphabetical; nothing is ranked or scored.

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface ActivityInput {
  commits: { sha: string; login?: string; date?: string }[];
  pulls: { number: number; login?: string; createdAt?: string; mergedAt?: string }[];
  reviews: { login?: string; submittedAt?: string }[];
  comments: { id: number; login?: string; createdAt?: string }[];
}

export interface ActivityRow {
  login: string;
  commits: number;
  opened: number;
  merged: number;
  reviews: number;
  comments: number;
}

export function weekStart(now: Date): Date {
  return new Date(now.getTime() - WEEK_MS);
}

export function aggregateActivity(input: ActivityInput, since: Date): ActivityRow[] {
  const rows = new Map<string, ActivityRow>();
  const after = (date?: string) => date !== undefined && new Date(date).getTime() >= since.getTime();
  const row = (login?: string) => {
    // Bots (dependabot[bot], github-actions[bot]) are not people on the team.
    if (!login || login.endsWith('[bot]')) return undefined;
    const key = login.toLowerCase();
    let r = rows.get(key);
    if (!r) {
      r = { login: key, commits: 0, opened: 0, merged: 0, reviews: 0, comments: 0 };
      rows.set(key, r);
    }
    return r;
  };
  const seen = new Set<string>();
  for (const c of input.commits) {
    if (seen.has(c.sha) || !after(c.date)) continue;
    seen.add(c.sha);
    const r = row(c.login);
    if (r) r.commits += 1;
  }
  for (const p of input.pulls) {
    if (after(p.createdAt)) {
      const r = row(p.login);
      if (r) r.opened += 1;
    }
    if (after(p.mergedAt)) {
      const r = row(p.login);
      if (r) r.merged += 1;
    }
  }
  for (const v of input.reviews) {
    if (!after(v.submittedAt)) continue;
    const r = row(v.login);
    if (r) r.reviews += 1;
  }
  const comments = new Set<number>();
  for (const c of input.comments) {
    if (comments.has(c.id) || !after(c.createdAt)) continue;
    comments.add(c.id);
    const r = row(c.login);
    if (r) r.comments += 1;
  }
  return [...rows.values()].sort((a, b) => (a.login < b.login ? -1 : a.login > b.login ? 1 : 0));
}
