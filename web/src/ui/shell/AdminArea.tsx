import type { ComponentChildren } from 'preact';
import { useT } from '../../i18n';
import { availableAdminTabs, type AdminTabId } from '../../shell/adminTabs';

export interface AdminAreaProps {
  /** Confirmed admin of the repository; anything else sees no admin content. */
  admin: boolean;
  tab: AdminTabId;
  onTab: (tab: AdminTabId) => void;
  /** The Project settings tab (the ProjectSettings container). */
  settings: ComponentChildren;
  coauthorView: boolean;
  onCoauthorView: (on: boolean) => void;
  /** Files co-authors see. */
  coauthorCount: number;
}

/**
 * Everything for admins in one place, opened from the single Admin entry:
 * tabs for Project settings and View as co-author now, and room for the admin
 * panel later (people, sessions, allowlist). Co-authors never get this
 * content, only a one-line notice.
 */
export function AdminArea({ admin, tab, onTab, settings, coauthorView, onCoauthorView, coauthorCount }: AdminAreaProps) {
  const t = useT();
  const m = t.admin;
  if (!admin) {
    return (
      <div class="page">
        <p class="notice" role="alert">
          {m.notAdmin}
        </p>
      </div>
    );
  }
  const tabs = availableAdminTabs();
  const move = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = tabs.findIndex((x) => x.id === tab);
    const next = tabs[(i + step + tabs.length) % tabs.length]?.id ?? tab;
    onTab(next);
    document.getElementById(`admin-tab-${next}`)?.focus();
  };
  return (
    <div class="page page-wide admin-area">
      <h1>{m.title}</h1>
      <div class="tabs" role="tablist" aria-label={m.tabs} onKeyDown={move}>
        {tabs.map(({ id }) => (
          <button
            key={id}
            id={`admin-tab-${id}`}
            type="button"
            role="tab"
            class="tab"
            aria-selected={tab === id}
            aria-controls={`admin-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => onTab(id)}
          >
            {m[id]}
          </button>
        ))}
      </div>
      <div id={`admin-panel-${tab}`} role="tabpanel" aria-labelledby={`admin-tab-${tab}`} class="tab-panel">
        {tab === 'settings' ? (
          settings
        ) : (
          <div class="view-as">
            <p class="muted">{m.viewAsLead}</p>
            <label class="switch-row">
              <input
                type="checkbox"
                role="switch"
                class="switch"
                checked={coauthorView}
                onChange={(e) => onCoauthorView(e.currentTarget.checked)}
              />
              <span>{m.viewAsOn}</span>
            </label>
            <p class="muted">{m.coauthorCount(coauthorCount)}</p>
          </div>
        )}
      </div>
    </div>
  );
}
