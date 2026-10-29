import { useT } from '../../i18n';
import { LAYOUTS, type Layout } from '../../shell/viewOptions';
import { Icon } from './icons';
import { Menu, MenuItem, MenuRadio, MenuSeparator } from './Menu';

export interface ViewMenuProps {
  layout: Layout;
  focus: boolean;
  onLayout: (layout: Layout) => void;
  onFocus: (on: boolean) => void;
  onToggle: () => void;
}

/** The header's View menu: layout, the text/preview toggle and focus mode. */
export function ViewMenu({ layout, focus, onLayout, onFocus, onToggle }: ViewMenuProps) {
  const t = useT();
  const m = t.view;
  return (
    <div class="view-menu">
      <Menu
        id="view-menu"
        label={m.options}
        buttonClass="view-button"
        tooltip={m.options}
        buttonContent={
          <>
            <Icon name="columns" />
            <span class="view-button-label">{m.title}</span>
          </>
        }
      >
        <div class="menu-group" role="group" aria-label={m.layout}>
          <span class="menu-group-label" aria-hidden="true">
            {m.layout}
          </span>
          {LAYOUTS.map((choice) => (
            <MenuRadio key={choice} checked={layout === choice} onSelect={() => onLayout(choice)}>
              {m.layouts[choice]}
            </MenuRadio>
          ))}
        </div>
        <MenuSeparator />
        <MenuItem onSelect={onToggle} kbd="Ctrl+Alt+V">
          {m.toggle}
        </MenuItem>
        <MenuItem onSelect={() => onFocus(!focus)}>{focus ? m.exitFocusLong : m.focus}</MenuItem>
      </Menu>
    </div>
  );
}
