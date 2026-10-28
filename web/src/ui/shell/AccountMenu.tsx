import type { Person } from '../../domain';
import { useT } from '../../i18n';
import { useLocale } from '../../i18n/LocaleProvider';
import { ENDONYMS, type Locale } from '../../i18n/locale';
import { THEMES, type Theme } from '../../shell/theme';
import { Menu, MenuGroup, MenuItem, MenuRadio, MenuSeparator } from './Menu';

export interface AccountMenuProps {
  user?: Person;
  theme: Theme;
  /** Icon rail: the button shows the avatar only. */
  compact: boolean;
  onTheme: (theme: Theme) => void;
  onPreferences: () => void;
  onShortcuts: () => void;
  onTour: () => void;
  onAbout: () => void;
  onSignOut: () => void;
}

/** Spec order: English · Español. */
export const MENU_LOCALES: readonly Locale[] = ['en', 'es'];

export function initials(login: string): string {
  return login.slice(0, 2).toUpperCase();
}

/**
 * The avatar button and its menu. The same for every role: admin tools live
 * in the Admin area only. Sign out is last, after a separator, so it is never
 * one stray click away.
 */
export function AccountMenu({ user, theme, compact, onTheme, onPreferences, onShortcuts, onTour, onAbout, onSignOut }: AccountMenuProps) {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const login = user?.login ?? '';
  return (
    <Menu
      id="account-menu"
      label={login ? t.shell.accountOf(login) : t.shell.account}
      buttonClass="nav-item account-button"
      tooltip={compact ? login || t.shell.account : undefined}
      up
      start
      buttonContent={
        <>
          <span class="avatar" aria-hidden="true">
            {login ? initials(login) : '·'}
          </span>
          <span class="nav-label">{login || t.shell.account}</span>
        </>
      }
    >
      {login && (
        <p class="menu-header" role="presentation">
          <span>{t.shell.signedInAs(login)}</span>
          <span class="muted">{t.shell.via}</span>
        </p>
      )}
      <MenuGroup label={t.shell.theme}>
        {THEMES.map((value) => (
          <MenuRadio key={value} checked={theme === value} onSelect={() => onTheme(value)}>
            {t.theme[value]}
          </MenuRadio>
        ))}
      </MenuGroup>
      {/* Each language named in itself, with its own lang. */}
      <MenuGroup label={t.shell.language}>
        {MENU_LOCALES.map((l) => (
          <MenuRadio key={l} checked={locale === l} lang={l} onSelect={() => setLocale(l)}>
            {ENDONYMS[l]}
          </MenuRadio>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem onSelect={onPreferences}>{t.shell.preferences}</MenuItem>
      <MenuItem onSelect={onShortcuts} kbd="?">
        {t.shell.shortcuts}
      </MenuItem>
      <MenuItem onSelect={onTour}>{t.nav.tour}</MenuItem>
      <MenuItem onSelect={onAbout}>{t.nav.about}</MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={onSignOut} danger>
        {t.shell.signOut}
      </MenuItem>
    </Menu>
  );
}
