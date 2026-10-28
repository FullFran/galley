import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import type { Person, Repository } from '../../domain';
import { useT } from '../../i18n';
import { navLabel, visibleNav, type GroupId, type NavId, type NavItem } from '../../shell/nav';
import { autoOpen, groupKeyAction, isGroupOpen, readGroups, toggleGroup, writeGroups, type SidebarMode } from '../../shell/navGroups';
import { matchShortcut, typingInField } from '../../shell/shortcuts';
import type { SidebarControl } from '../../shell/useSidebar';
import { AboutDialog } from './AboutDialog';
import { AccountMenu } from './AccountMenu';
import { Icon } from './icons';
import { Menu, MenuItem } from './Menu';
import { PreferencesDialog } from './PreferencesDialog';
import { ShortcutsDialog } from './ShortcutsDialog';
import { useTheme } from './ThemeSwitch';
import { Toast, Toasts } from './Toasts';

/** What every signed-in screen shares, provided by App. */
export interface ShellContext {
  repo?: Repository;
  /** Admin of the open repository (fail closed: false until confirmed). */
  admin: boolean;
  user?: Person;
  /** Open proposals of the repository, and how many are the user's own. */
  proposals?: { count: number; mine: number };
  sidebar: SidebarControl;
  onNavigate: (id: NavId) => void;
  /** The repository switcher (the repository list). */
  onRepos: () => void;
  onSignOut: () => void;
}

/** A breadcrumb segment; with `onSelect` it is a button. */
export interface Crumb {
  label: string;
  onSelect?: () => void;
  title?: string;
}

export interface MoreItem {
  label: string;
  kbd?: string;
  /** Phones only: things that leave the narrow header (the save note). */
  narrowOnly?: boolean;
  onSelect: () => void;
}

export interface AppShellProps {
  shell: ShellContext;
  active?: NavId;
  /** Breadcrumb, from the repository to the current item. */
  crumbs: (string | Crumb)[];
  /** Right side of the header; screens put <MoreMenu> in it. Without it the header shows the ⋯ menu alone. */
  actions?: ComponentChildren;
  /** Outline | Files, under the Contents entry (workspace only). */
  contents?: ComponentChildren;
  /** One-line banners above the screen (view as co-author, not set up). */
  banner?: ComponentChildren;
  toasts?: ComponentChildren;
  mainClass?: string;
  children: ComponentChildren;
}

const UiContext = createContext<{ openShortcuts: () => void }>({ openShortcuts: () => undefined });

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The header ⋯ menu: the screen's own actions, then Keyboard shortcuts. */
export function MoreMenu({ items = [] }: { items?: MoreItem[] }) {
  const t = useT();
  const { openShortcuts } = useContext(UiContext);
  return (
    <Menu id="more-menu" label={t.shell.more} buttonClass="icon-button more-button" tooltip={t.shell.more} buttonContent={<Icon name="dots" />}>
      {items.map((item) => (
        <MenuItem key={item.label} onSelect={item.onSelect} kbd={item.kbd} narrowOnly={item.narrowOnly}>
          {item.label}
        </MenuItem>
      ))}
      <MenuItem onSelect={openShortcuts} kbd="?">
        {t.shell.shortcuts}
      </MenuItem>
    </Menu>
  );
}

const GROUP_LABEL = { write: 'groupWrite', review: 'groupReview', admin: 'groupAdmin' } as const;

/**
 * The app shell: skip link, collapsible sidebar (16rem, 3.5rem icon rail, or
 * an off-canvas drawer on phones), sticky header and the scrolling main
 * region. The sidebar holds the repository switcher, task groups (Write,
 * Review, and Admin for admins), then Help, the account and the credit.
 */
export function AppShell({ shell, active, crumbs, actions, contents, banner, toasts, mainClass, children }: AppShellProps) {
  const t = useT();
  const { state, dispatch, toggleRef, panelRef } = shell.sidebar;
  const [about, setAbout] = useState(false);
  const [tourNotice, setTourNotice] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [prefs, setPrefs] = useState(false);
  const [theme, setTheme] = useTheme();
  const [groupState, setGroupState] = useState(() => autoOpen(readGroups(storage()), active));
  const narrow = state.viewport === 'narrow';
  const collapsed = state.collapsed && !narrow;
  const mode: SidebarMode = narrow ? 'drawer' : collapsed ? 'rail' : 'full';
  const groups = visibleNav({ repoOpen: shell.repo !== undefined, admin: shell.admin });

  // The group of the current screen opens by itself.
  useEffect(() => {
    setGroupState((s) => {
      const next = autoOpen(s, active);
      if (next !== s) writeGroups(storage(), next);
      return next;
    });
  }, [active]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchShortcut(e, typingInField(e.target)) !== 'help') return;
      e.preventDefault();
      setShortcuts(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggle = (id: GroupId) => {
    const next = toggleGroup(groupState, id, mode);
    setGroupState(next);
    writeGroups(storage(), next);
  };

  const choose = (item: NavItem) => {
    if (item.id === 'contents') dispatch({ type: 'expand' });
    dispatch({ type: 'navigate' });
    shell.onNavigate(item.id);
  };

  const proposalsMeta = () => {
    if (!shell.proposals) return undefined;
    const { count, mine } = shell.proposals;
    return mine > 0 ? `${count} · ${t.nav.mine(mine)}` : `${count}`;
  };

  const itemLabel = (item: NavItem) =>
    item.id === 'proposals' && shell.proposals ? t.nav.proposalsCount(shell.proposals.count) : navLabel(item.id, t);

  return (
    <UiContext.Provider value={{ openShortcuts: () => setShortcuts(true) }}>
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
          <div class="repo-switch-row">
            <button
              type="button"
              class="nav-item repo-switch"
              aria-label={shell.repo ? `${t.nav.switchRepo}: ${shell.repo.fullName}` : t.nav.chooseRepo}
              data-tooltip={collapsed ? (shell.repo ? shell.repo.fullName : t.nav.chooseRepo) : undefined}
              title={collapsed ? undefined : t.nav.switchRepo}
              onClick={() => {
                dispatch({ type: 'navigate' });
                shell.onRepos();
              }}
            >
              <Icon name="library" />
              <span class="nav-label">{shell.repo ? shell.repo.name : t.nav.chooseRepo}</span>
              <Icon name="selector" class="repo-switch-icon" />
            </button>
          </div>
          <nav class="sidebar-nav" aria-label={t.shell.mainNav}>
            {groups.map((group) => {
              const open = isGroupOpen(group.id, groupState, mode);
              const listId = `nav-group-${group.id}`;
              const label = t.nav[GROUP_LABEL[group.id]];
              return (
                <section key={group.id} class={group.separated ? 'nav-group nav-group-separated' : 'nav-group'}>
                  {group.collapsible && mode === 'full' ? (
                    <button
                      type="button"
                      class="nav-group-head"
                      aria-expanded={open}
                      aria-controls={listId}
                      onClick={() => toggle(group.id)}
                      onKeyDown={(e) => {
                        const action = groupKeyAction(e.key, open);
                        if (!action) return;
                        e.preventDefault();
                        toggle(group.id);
                      }}
                    >
                      <span>{label}</span>
                      <Icon name="chevron" class="nav-group-chevron" />
                    </button>
                  ) : (
                    group.id !== 'admin' && (
                      <h2 class="nav-group-label" aria-hidden={mode === 'rail' ? 'true' : undefined}>
                        {label}
                      </h2>
                    )
                  )}
                  <ul id={listId} class="nav-list" hidden={!open}>
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
                          {item.id === 'proposals' && proposalsMeta() && (
                            <span class="nav-meta" aria-hidden="true">
                              {proposalsMeta()}
                            </span>
                          )}
                        </button>
                        {item.id === 'contents' && contents && <div class="sidebar-panel">{contents}</div>}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </nav>
          <div class="sidebar-foot">
            <div class="sidebar-foot-row">
              <AccountMenu
                user={shell.user}
                theme={theme}
                compact={collapsed}
                onTheme={setTheme}
                onPreferences={() => setPrefs(true)}
                onShortcuts={() => setShortcuts(true)}
                onTour={() => setTourNotice(true)}
                onAbout={() => setAbout(true)}
                onSignOut={shell.onSignOut}
              />
              <Menu
                id="help-menu"
                label={t.nav.help}
                buttonClass="icon-button help-button"
                tooltip={t.nav.help}
                up
                tour="help"
                buttonContent={<Icon name="help" />}
              >
                <MenuItem onSelect={() => setTourNotice(true)}>{t.nav.tour}</MenuItem>
                <MenuItem onSelect={() => setShortcuts(true)} kbd="?">
                  {t.shell.shortcuts}
                </MenuItem>
                <MenuItem onSelect={() => setAbout(true)}>{t.nav.about}</MenuItem>
              </Menu>
            </div>
            <button type="button" class="credit-line" title={t.nav.about} onClick={() => setAbout(true)}>
              {t.shell.creditLine}
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
                {crumbs.map((raw, i) => {
                  const crumb = typeof raw === 'string' ? { label: raw } : raw;
                  const last = i === crumbs.length - 1;
                  return (
                    <li key={i} aria-current={last ? 'location' : undefined}>
                      {crumb.onSelect ? (
                        <button type="button" class="crumb" title={crumb.title} onClick={crumb.onSelect}>
                          {crumb.label}
                        </button>
                      ) : (
                        crumb.label
                      )}
                    </li>
                  );
                })}
              </ol>
            </nav>
            <div class="header-actions">{actions ?? <MoreMenu />}</div>
          </header>
          {banner && <div class="shell-banners">{banner}</div>}
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
        <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
        <PreferencesDialog open={prefs} theme={theme} onTheme={setTheme} onClose={() => setPrefs(false)} />
      </div>
    </UiContext.Provider>
  );
}
