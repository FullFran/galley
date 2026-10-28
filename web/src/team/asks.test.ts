import { describe, expect, it } from 'vitest';
import { ASK_LABEL, askIssue, isDueDate, milestoneDue, milestoneTitle, toAsk, mergeAsks } from './asks';

describe('ask issues', () => {
  it('builds a "Review: ..." issue with links, the galley route, the label and the assignee', () => {
    const issue = askIssue({
      what: 'Methods',
      galleyUrl: 'https://galley.example/#/r/octo/paper/f/sections/02-methods.qmd',
      githubUrl: 'https://github.com/octo/paper/blob/main/sections/02-methods.qmd',
      assignee: 'ben',
      due: '2026-10-30',
      note: 'Please check the stats.',
      milestone: 3,
    });
    expect(issue.title).toBe('Review: Methods');
    expect(issue.labels).toEqual([ASK_LABEL]);
    expect(issue.assignees).toEqual(['ben']);
    expect(issue.milestone).toBe(3);
    expect(issue.body).toContain('https://galley.example/#/r/octo/paper/f/sections/02-methods.qmd');
    expect(issue.body).toContain('https://github.com/octo/paper/blob/main/sections/02-methods.qmd');
    expect(issue.body).toContain('2026-10-30');
    expect(issue.body).toContain('Please check the stats.');
  });

  it('keeps the title short and on one line', () => {
    const title = askIssue({ what: `A\nB${'x'.repeat(300)}`, galleyUrl: 'u', assignee: 'b', due: '2026-10-30' }).title;
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title).not.toContain('\n');
  });

  it('dates: milestone title, due_on at noon UTC (GitHub keeps the day), validation', () => {
    expect(milestoneTitle('2026-10-30')).toBe('Due 2026-10-30');
    expect(milestoneDue('2026-10-30')).toBe('2026-10-30T12:00:00Z');
    expect(isDueDate('2026-10-30')).toBe(true);
    expect(isDueDate('2026-13-01')).toBe(false);
    expect(isDueDate('2026-02-30')).toBe(false);
    expect(isDueDate('30/10/2026')).toBe(false);
  });
});

describe('My asks', () => {
  const now = new Date('2026-10-28T10:00:00Z');
  const issue = (n: number, due?: string, extra: Record<string, unknown> = {}) => ({
    number: n,
    title: `Review: S${n}`,
    html_url: `https://github.com/octo/paper/issues/${n}`,
    state: 'open',
    user: { login: 'ana' },
    assignees: [{ login: 'ben' }],
    comments: 2,
    milestone: due ? { title: `Due ${due}`, due_on: `${due}T12:00:00Z` } : null,
    ...extra,
  });

  it('maps issues to asks with due date, overdue flag and my role', () => {
    expect(toAsk(issue(1, '2026-10-27'), 'ben', now)).toMatchObject({
      number: 1,
      due: '2026-10-27',
      overdue: true,
      toMe: true,
      byMe: false,
      creator: 'ana',
      assignees: ['ben'],
      comments: 2,
    });
    expect(toAsk(issue(2, '2026-10-28'), 'ana', now)).toMatchObject({ overdue: false, toMe: false, byMe: true });
    expect(toAsk(issue(3), 'ben', now)).toMatchObject({ due: undefined, overdue: false });
  });

  it('skips pull requests and merges the two lists, soonest due first, undated last', () => {
    const list = mergeAsks(
      [issue(1, '2026-11-02'), issue(2), issue(9, '2026-10-01', { pull_request: {} })],
      [issue(1, '2026-11-02'), issue(3, '2026-10-29')],
      'ben',
      now,
    );
    expect(list.map((a) => a.number)).toEqual([3, 1, 2]);
  });
});
