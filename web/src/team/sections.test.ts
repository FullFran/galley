import { describe, expect, it } from 'vitest';
import { parseCodeowners } from './codeowners';
import { canChangeStatus, initials, ownerLogins, sectionOwners, sectionPaths } from './sections';
import type { OutlineItem } from '../shell/outline';

const items: OutlineItem[] = [
  { kind: 'heading', level: 1, title: 'Paper', line: 1 },
  { kind: 'include', path: 'sections/01-intro.qmd', line: 3 },
  { kind: 'include', path: 'sections/02-methods.qmd', line: 4 },
];

describe('owners of sections', () => {
  it('maps the main file and each included section to its owners', () => {
    const rules = parseCodeowners('* @ana\n/sections/02-methods.qmd @ben @org/stats\n');
    expect(sectionPaths('index.qmd', items)).toEqual(['index.qmd', 'sections/01-intro.qmd', 'sections/02-methods.qmd']);
    expect(sectionOwners(rules, sectionPaths('index.qmd', items))).toEqual({
      'index.qmd': ['@ana'],
      'sections/01-intro.qmd': ['@ana'],
      'sections/02-methods.qmd': ['@ben', '@org/stats'],
    });
  });

  it('user logins only, for review requests (teams and emails need other calls)', () => {
    expect(ownerLogins(['@ben', '@org/stats', 'x@y.org', '@Ana'], 'ana')).toEqual(['ben']);
  });

  it('initials for an owner chip', () => {
    expect(initials('@ben-smith')).toBe('BS');
    expect(initials('@org/stats')).toBe('ST');
    expect(initials('@x')).toBe('X');
    expect(initials('mail@example.org')).toBe('MA');
  });

  it('admins and the section owners may change its status', () => {
    expect(canChangeStatus({ admin: true, me: 'zoe', owners: [] })).toBe(true);
    expect(canChangeStatus({ admin: false, me: 'Ben', owners: ['@ben'] })).toBe(true);
    expect(canChangeStatus({ admin: false, me: 'cleo', owners: ['@ben', '@org/stats'] })).toBe(false);
    expect(canChangeStatus({ admin: false, me: undefined, owners: ['@ben'] })).toBe(false);
  });
});
