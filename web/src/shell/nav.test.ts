import { describe, expect, it } from 'vitest';
import { groupOf, NAV_ITEMS, visibleNav } from './nav';

const ids = (groups: ReturnType<typeof visibleNav>) => groups.map((g) => [g.id, g.items.map((i) => i.id)]);

describe('navigation data', () => {
  it('is declared once, with unique ids and a tour anchor for proposals', () => {
    const all = NAV_ITEMS.map((i) => i.id);
    expect(new Set(all).size).toBe(all.length);
    expect(NAV_ITEMS.find((i) => i.id === 'proposals')?.tour).toBe('proposals');
  });

  it('has no task groups before a repository is open (the repo switcher row stands alone)', () => {
    expect(visibleNav({ repoOpen: false, admin: false })).toEqual([]);
    expect(visibleNav({ repoOpen: false, admin: true })).toEqual([]);
  });

  it('shows Write and Review to co-authors, without any admin entry', () => {
    const groups = visibleNav({ repoOpen: true, admin: false });
    expect(ids(groups)).toEqual([
      ['write', ['contents', 'references']],
      ['review', ['proposals', 'comments', 'chat', 'history']],
    ]);
    expect(groups.flatMap((g) => g.items).some((i) => i.id === 'admin')).toBe(false);
  });

  it('adds one Admin entry for admins, last and behind a separator', () => {
    const groups = visibleNav({ repoOpen: true, admin: true });
    expect(ids(groups)).toEqual([
      ['write', ['contents', 'references']],
      ['review', ['proposals', 'comments', 'chat', 'history']],
      ['admin', ['admin']],
    ]);
    expect(groups[2]?.separated).toBe(true);
    expect(groups[2]?.collapsible).toBe(false);
  });

  it('makes only Review collapsible; Write never collapses', () => {
    const groups = visibleNav({ repoOpen: true, admin: true });
    expect(groups.filter((g) => g.collapsible).map((g) => g.id)).toEqual(['review']);
  });

  it('knows the group of every entry', () => {
    expect(groupOf('contents')).toBe('write');
    expect(groupOf('proposals')).toBe('review');
    expect(groupOf('history')).toBe('review');
    expect(groupOf('admin')).toBe('admin');
  });
});
