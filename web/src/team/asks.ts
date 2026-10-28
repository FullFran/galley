// Asks with due dates: a GitHub issue labelled `galley-ask`, assigned to the
// person asked, in a milestone named after the due date. "My asks" lists the
// open ones assigned to me or opened by me.

export const ASK_LABEL = 'galley-ask';
export const ASK_LABEL_COLOR = '5319e7';
export const ASK_LABEL_DESCRIPTION = 'Asked from galley: a review or task with a due date';
const MAX_TITLE = 120;
export const MAX_NOTE = 2000;

export interface AskInput {
  /** What to look at: a section name or a proposal title. */
  what: string;
  /** The galley route of the section or proposal. */
  galleyUrl: string;
  /** The file or proposal on github.com. */
  githubUrl?: string;
  assignee: string;
  /** `YYYY-MM-DD`. */
  due: string;
  note?: string;
}

export interface AskIssueBody {
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  milestone?: number;
}

export function isDueDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export const milestoneTitle = (due: string) => `Due ${due}`;
/** Noon UTC: GitHub keeps the calendar day whatever the time zone it shows. */
export const milestoneDue = (due: string) => `${due}T12:00:00Z`;

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export function askIssue(input: AskInput & { milestone?: number }): AskIssueBody {
  const what = oneLine(input.what);
  let title = `Review: ${what}`;
  if (title.length > MAX_TITLE) title = `${title.slice(0, MAX_TITLE - 1)}…`;
  const lines = [
    `Please review **${what.replace(/[*_`[\]<>]/g, '')}** by ${input.due}.`,
    '',
    `- Open in galley: ${input.galleyUrl}`,
    ...(input.githubUrl ? [`- On GitHub: ${input.githubUrl}`] : []),
  ];
  const note = input.note?.trim().slice(0, MAX_NOTE);
  if (note) lines.push('', ...note.split('\n').map((l) => `> ${l}`));
  lines.push('', '_Asked from galley. Close this issue when it is done._');
  const issue: AskIssueBody = { title, body: lines.join('\n'), labels: [ASK_LABEL], assignees: [input.assignee] };
  if (input.milestone !== undefined) issue.milestone = input.milestone;
  return issue;
}

export interface GhIssue {
  number: number;
  title: string;
  html_url: string;
  state?: string;
  user?: { login: string } | null;
  assignees?: { login: string }[] | null;
  comments?: number;
  milestone?: { title?: string; due_on?: string | null } | null;
  pull_request?: unknown;
}

export interface Ask {
  number: number;
  title: string;
  url: string;
  creator?: string;
  assignees: string[];
  comments: number;
  /** `YYYY-MM-DD`, from the milestone. */
  due?: string;
  overdue: boolean;
  toMe: boolean;
  byMe: boolean;
}

function dueOf(m: GhIssue['milestone']): string | undefined {
  if (!m) return undefined;
  const fromDate = typeof m.due_on === 'string' ? m.due_on.slice(0, 10) : undefined;
  if (fromDate && isDueDate(fromDate)) return fromDate;
  const fromTitle = /^Due (\d{4}-\d{2}-\d{2})$/.exec(m.title ?? '')?.[1];
  return fromTitle && isDueDate(fromTitle) ? fromTitle : undefined;
}

const same = (a?: string, b?: string) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

export function toAsk(issue: GhIssue, me: string, now: Date): Ask {
  const due = dueOf(issue.milestone);
  const assignees = (issue.assignees ?? []).map((a) => a.login);
  const today = now.toISOString().slice(0, 10);
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    creator: issue.user?.login,
    assignees,
    comments: issue.comments ?? 0,
    due,
    overdue: due !== undefined && due < today,
    toMe: assignees.some((a) => same(a, me)),
    byMe: same(issue.user?.login, me),
  };
}

/** Assigned to me and opened by me, once each, soonest due first; undated last. */
export function mergeAsks(assigned: GhIssue[], created: GhIssue[], me: string, now: Date): Ask[] {
  const byNumber = new Map<number, Ask>();
  for (const issue of [...assigned, ...created]) {
    if (issue.pull_request !== undefined || byNumber.has(issue.number)) continue;
    byNumber.set(issue.number, toAsk(issue, me, now));
  }
  return [...byNumber.values()].sort((a, b) => {
    if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
    if (a.due && !b.due) return -1;
    if (!a.due && b.due) return 1;
    return a.number - b.number;
  });
}
