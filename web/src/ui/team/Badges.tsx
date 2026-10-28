import type { ComponentChildren } from 'preact';
import { useT } from '../../i18n';
import { initials, type SectionStatus } from '../../team/sections';
import './badges.css';

/** Team features of the outline: owners, status and the section's menu items. */
export interface OutlineTeam {
  owners: (path: string) => string[];
  status: (path: string) => { status: SectionStatus; unsaved: boolean } | undefined;
  /** Menu items for a section file, or null when there are none. */
  menu: (path: string, name: string) => ComponentChildren;
}

const MAX_CHIPS = 3;

/** Owner initials (login in the tooltip) and the status badge of one section. */
export function SectionBadges({ team, path }: { team: OutlineTeam; path: string }) {
  const t = useT().team;
  const owners = team.owners(path);
  const status = team.status(path);
  if (owners.length === 0 && !status) return null;
  const list = owners.join(', ');
  const label = status ? (status.unsaved ? t.unsaved(t.status[status.status]) : t.status[status.status]) : '';
  return (
    <span class="team-badges">
      {status && (
        <span class={`status-badge status-${status.status}${status.unsaved ? ' status-unsaved' : ''}`} title={label}>
          {t.status[status.status]}
        </span>
      )}
      {owners.length > 0 && (
        <span class="owner-chips" role="img" aria-label={t.owners(list)} title={t.owners(list)}>
          {owners.slice(0, MAX_CHIPS).map((o) => (
            <span key={o} class="owner-chip" aria-hidden="true">
              {initials(o)}
            </span>
          ))}
          {owners.length > MAX_CHIPS && (
            <span class="owner-chip owner-more" aria-hidden="true">
              +{owners.length - MAX_CHIPS}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
