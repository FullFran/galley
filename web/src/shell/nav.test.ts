import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, visibleNav } from './nav';

const ids = (groups: ReturnType<typeof visibleNav>) => groups.map((g) => g.items.map((i) => i.id));

describe('navigation data', () => {
  it('is declared once, with unique ids and a tour anchor for the main regions', () => {
    const all = NAV_ITEMS.map((i) => i.id);
    expect(new Set(all).size).toBe(all.length);
    expect(NAV_ITEMS.find((i) => i.id === 'proposals')?.tour).toBe('proposals');
  });

  it('offers only the repository list before a repository is open', () => {
    expect(ids(visibleNav({ repoOpen: false, admin: false }))).toEqual([['repos'], ['tour', 'about']]);
  });

  it('shows paper, files and proposals in an open repository, without settings for co-authors', () => {
    const groups = visibleNav({ repoOpen: true, admin: false });
    expect(ids(groups)).toEqual([['repos', 'paper', 'files', 'proposals'], ['tour', 'about']]);
    expect(groups.flatMap((g) => g.items).some((i) => i.id === 'settings')).toBe(false);
  });

  it('adds project settings for admins in their own group, behind a separator', () => {
    const groups = visibleNav({ repoOpen: true, admin: true });
    expect(ids(groups)).toEqual([['repos', 'paper', 'files', 'proposals'], ['settings'], ['tour', 'about']]);
    expect(groups[1]?.separated).toBe(true);
  });

  it('never shows settings without an open repository, even for admins', () => {
    expect(ids(visibleNav({ repoOpen: false, admin: true }))).toEqual([['repos'], ['tour', 'about']]);
  });
});
