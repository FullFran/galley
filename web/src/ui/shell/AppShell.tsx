import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Person, Repository } from '../../domain';
import { useT } from '../../i18n';
import { navLabel, visibleNav, type NavId, type NavItem } from '../../shell/nav';
import type { SidebarControl } from '../../shell/useSidebar';
import { AboutDialog } from './AboutDialog';
import { Credit } from './Credit';
import { Icon } from './icons';
import { Toast, Toasts } from './Toasts';

/** What every signed-in screen shares, provided by App. */
export interface ShellContext {
  repo?: Repository;
  /** Admin of the open repository (fail closed: false until confirmed). */
  admin: boolean;
  user?: Person;
  /** Open proposals of the repository, and the number of the user's own. */
  proposals?: { count: number; mine?: number };
  sidebar: SidebarControl;
  onNavigate: (id: NavId) => void;
  onSignOut: () => void;
  /** The ES | EN switcher App provides for every signed-in screen. */
  languageSwitch?: ComponentChildren;
}

export interface AppShellProps {
  shell: ShellContext;
  active?: NavId;
  /** Breadcrumb, from the repository to the current item. */
  crumbs: string[];
  /** Right side of the header: save state and actions of the screen. */
  actions?: ComponentChildren;
  /** Sidebar content shown under the Paper and Files entries (workspace only). */
  panels?: { paper?: ComponentChildren; files?: ComponentChildren };
  toasts?: ComponentChildren;
  /** Slot in the sidebar footer for the language switcher (ES | EN); defaults to `shell.languageSwitch`. */
  languageSwitch?: ComponentChildren;
  mainClass?: string;
  children: ComponentChildren;
}

const FILES_PANEL = 'sidebar-files';

/**
 * The app shell: skip link, collapsible sidebar (16rem, 3.5rem icon rail, or
 * an off-canvas drawer on phones), sticky header and the scrolling main
 * region. Sidebar, editor and preview scroll on their own; the header stays.
 */
export function AppShell({ shell, active, crumbs, actions, panels, toasts, languageSwitch, mainClass, children }: AppShellProps) {
  const t = useT();
  const { state, dispatch, toggleRef, panelRef } = shell.sidebar;
  const [about, setAbout] = useState(false);
  const [tourNotice, setTourNotice] = useState(false);
  const [focusFiles, setFocusFiles] = useState(0);
  const narrow = state.viewport === 'narrow';
  const collapsed = state.collapsed && !narrow;
  const groups = visibleNav({ repoOpen: shell.repo !== undefined, admin: shell.admin });

  useEffect(() => {
    if (focusFiles) document.getElementById(FILES_PANEL)?.scrollIntoView({ block: 'nearest' });
  }, [focusFiles]);

  const choose = (item: NavItem) => {
    if (item.id === 'about') return setAbout(true);
    if (item.id === 'tour') return setTourNotice(true);
    if (item.id === 'paper' || item.id === 'files') dispatch({ type: 'expand' });
    if (item.id === 'files') setFocusFiles((n) => n + 1);
    dispatch({ type: 'navigate' });
    shell.onNavigate(item.id);
  };

  const itemLabel = (item: NavItem) =>
    item.id === 'proposals' && shell.proposals ? t.nav.proposalsCount(shell.proposals.count) : navLabel(item.id, t);

  return (
    <div class="shell" data-collapsed={collapsed ? 'true' : undefined} data-drawer={state.drawerOpen ? 'open' : undefined}>
      <a
        class="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        {t.shell.skip}
      </a>
      <aside
        id="sidebar"
        ref={panelRef}
        class="sidebar"
        aria-label={t.shell.sidebar}
        data-tour="sidebar"
        inert={narrow && !state.drawerOpen}
      >
        <div class="sidebar-head">
          <span class="brand">{t.app.name}</span>
          <button
            type="button"
            class="icon-button sidebar-toggle"
            aria-label={narrow ? t.shell.closeMenu : collapsed ? t.shell.expand : t.shell.collapse}
            data-tooltip={narrow ? undefined : `${collapsed ? t.shell.expand : t.shell.collapse} (${t.shell.shortcut})`}
            aria-expanded={narrow ? state.drawerOpen : !collapsed}
            aria-controls="sidebar"
            aria-keyshortcuts="Control+B Meta+B"
            onClick={() => dispatch({ type: 'toggle' })}
          >
            <Icon name={narrow ? 'close' : 'panel'} />
          </button>
        </div>
        <nav class="sidebar-nav" aria-label={t.shell.mainNav}>
          {groups.map((group) => (
            <ul key={group.id} class={group.separated ? 'nav-group nav-group-separated' : 'nav-group'}>
              {group.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    class="nav-item"
                    aria-current={item.id === active ? 'page' : undefined}
                    aria-label={itemLabel(item)}
                    data-tooltip={collapsed ? itemLabel(item) : undefined}
                    data-tour={item.tour}
                    onClick={() => choose(item)}
                  >
                    <Icon name={item.icon} />
                    <span class="nav-label">{navLabel(item.id, t)}</span>
                    {item.id === 'proposals' && shell.proposals && shell.proposals.count > 0 && (
                      <span class="badge" aria-hidden="true">
                        {shell.proposals.count}
                      </span>
                    )}
                  </button>
                  {item.id === 'proposals' && shell.proposals?.mine !== undefined && (
                    <p class="nav-sub muted">{t.nav.mine(shell.proposals.mine)}</p>
                  )}
                  {item.id === 'paper' && panels?.paper && <div class="sidebar-panel">{panels.paper}</div>}
                  {item.id === 'files' && panels?.files && (
                    <div class="sidebar-panel" id={FILES_PANEL}>
                      {panels.files}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ))}
        </nav>
        <div class="sidebar-foot">
          {shell.user && (
            <p class="account" title={t.shell.signedInAs(shell.user.login)}>
              <span class="nav-label">{shell.user.login}</span>
            </p>
          )}
          <button
            type="button"
            class="nav-item"
            aria-label={t.shell.signOut}
            data-tooltip={collapsed ? t.shell.signOut : undefined}
            onClick={shell.onSignOut}
          >
            <Icon name="logout" />
            <span class="nav-label">{t.shell.signOut}</span>
          </button>
          {(languageSwitch ?? shell.languageSwitch) && <div class="language-slot">{languageSwitch ?? shell.languageSwitch}</div>}
          <div class="sidebar-credit">
            <Credit />
          </div>
          <button
            type="button"
            class="icon-button credit-icon"
            aria-label={t.nav.about}
            data-tooltip={t.nav.about}
            onClick={() => setAbout(true)}
          >
            <Icon name="info" />
          </button>
        </div>
      </aside>
      <div class="scrim" hidden={!state.drawerOpen} onClick={() => dispatch({ type: 'closeDrawer' })} />
      <div class="shell-main">
        <header class="shell-header">
          <button
            type="button"
            ref={toggleRef}
            class="icon-button menu-button"
            aria-label={t.shell.openMenu}
            aria-expanded={state.drawerOpen}
            aria-controls="sidebar"
            onClick={() => dispatch({ type: 'toggle' })}
          >
            <Icon name="menu" />
          </button>
          <nav class="breadcrumb" aria-label={t.shell.breadcrumb}>
            <ol>
              {crumbs.map((crumb, i) => (
                <li key={i} aria-current={i === crumbs.length - 1 ? 'location' : undefined}>
                  {crumb}
                </li>
              ))}
            </ol>
          </nav>
          <div class="header-actions">{actions}</div>
        </header>
        <main id="main" tabIndex={-1} class={mainClass ? `shell-content ${mainClass}` : 'shell-content'}>
          {children}
        </main>
      </div>
      <Toasts>
        {tourNotice && (
          <Toast onDismiss={() => setTourNotice(false)}>
            <p role="status">{t.nav.tourSoon}</p>
          </Toast>
        )}
        {toasts}
      </Toasts>
      <AboutDialog open={about} onClose={() => setAbout(false)} />
    </div>
  );
}
