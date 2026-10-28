import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import { Outline } from '../shell/Outline';
import type { OutlineTeam } from './Badges';
import { MenuItem } from '../shell/Menu';

const noop = () => undefined;

describe('outline team badges', () => {
  const team: OutlineTeam = {
    owners: (p) => (p === 'sections/02-methods.qmd' ? ['@ben-smith', '@org/stats'] : []),
    status: (p) => (p === 'sections/02-methods.qmd' ? { status: 'in_review', unsaved: false } : undefined),
    menu: (_p, name) => <MenuItem onSelect={noop}>{`Ask about ${name}`}</MenuItem>,
  };

  it('shows owner initials with logins in the tooltip, the status badge and the team menu items', () => {
    const html = render(
      <Outline
        main="index.qmd"
        openPath="index.qmd"
        items={[{ kind: 'include', path: 'sections/02-methods.qmd', line: 3 }]}
        label={(p) => (p === 'sections/02-methods.qmd' ? 'Methods' : p)}
        onOpenFile={noop}
        onHeading={noop}
        team={team}
      />,
    );
    expect(html).toContain('title="Owners: @ben-smith, @org/stats"');
    expect(html).toContain('>BS<');
    expect(html).toContain('>ST<');
    expect(html).toContain('status-in_review');
    expect(html).toContain('In review');
    expect(html).toContain('Ask about Methods');
  });

  it('renders user text as text, not markup', () => {
    const html = render(
      <Outline
        main="index.qmd"
        openPath="index.qmd"
        items={[{ kind: 'include', path: 'a.qmd', line: 3 }]}
        label={() => '<img src=x>'}
        onOpenFile={noop}
        onHeading={noop}
        team={{ ...team, owners: () => ['@ana'] }}
      />,
    );
    expect(html).not.toContain('<img src=x>');
  });
});
