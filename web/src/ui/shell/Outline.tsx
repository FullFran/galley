import { Fragment, type ComponentChildren } from 'preact';
import { useT } from '../../i18n';
import type { OutlineItem } from '../../shell/outline';
import { Icon } from './icons';
import { Menu, MenuItem } from './Menu';

type Heading = Extract<OutlineItem, { kind: 'heading' }>;

/** New section / New subsection, offered only to people who may change the structure. */
export interface OutlineStructure {
  /**
   * A new section after the include on this line of the main file, at the
   * `start`, or (undefined) at the default place: after the open section.
   */
  onNewSection: (after?: number | 'start') => void;
  /** A subsection under a heading of the open file (`line`), or inside an included file (`path`). */
  onNewSubsection: (target: { path?: string; line?: number; title: string }) => void;
}

export interface OutlineProps {
  main?: string;
  openPath?: string;
  items: OutlineItem[];
  label: (path: string) => string;
  onOpenFile: (path: string) => void;
  onHeading: (item: Heading) => void;
  structure?: OutlineStructure;
  /** Word count of a heading's section or an included file ("1,204 words"). */
  words?: (item: OutlineItem) => string | undefined;
}

/** The Paper panel: the main file pinned first, then the outline of the open file. */
export function Outline({ main, openPath, items, label, onOpenFile, onHeading, structure, words }: OutlineProps) {
  const t = useT();
  const m = t.outline;
  const a = t.authoring;
  // Includes of the main file are its sections; a + between them adds one there.
  const inMain = openPath !== undefined && openPath === main;
  const firstInclude = items.findIndex((i) => i.kind === 'include');
  const gap = (after: number | 'start', key: string) =>
    structure && inMain ? (
      <li key={key} class="outline-gap">
        <button type="button" class="outline-add" aria-label={a.newSectionHere} title={a.newSectionHere} onClick={() => structure.onNewSection(after)}>
          +
        </button>
      </li>
    ) : null;
  const rowMenu = (id: string, name: string, children: ComponentChildren) =>
    structure ? (
      <Menu id={`outline-menu-${id}`} label={a.rowActions(name)} buttonClass="icon-button outline-more" buttonContent={<Icon name="dots" />}>
        {children}
      </Menu>
    ) : null;
  const count = (item: OutlineItem) => {
    const text = words?.(item);
    return text ? (
      <span class="muted outline-words" title={text}>
        {text}
      </span>
    ) : null;
  };
  return (
    <div class="outline-panel" data-tour="outline">
      {main && (
        <button
          type="button"
          class="tree-item outline-main"
          aria-current={openPath === main ? 'true' : undefined}
          title={main}
          onClick={() => onOpenFile(main)}
        >
          <Icon name="document" />
          <span class="tree-label">{label(main)}</span>
          <span class="muted tree-suffix" title={m.mainFileHint}>
            {m.mainFile}
          </span>
        </button>
      )}
      {openPath && (
        <ul class="outline" aria-label={m.outlineOf(label(openPath))}>
          {items.map((item, i) => (
            <Fragment key={`${item.line}`}>
              {i === firstInclude && gap('start', 'gap-start')}
              <li class={item.kind === 'heading' ? `outline-l${Math.min(item.level, 4)} outline-row` : 'outline-include outline-row'}>
                {item.kind === 'heading' ? (
                  <>
                    <button type="button" class="tree-item" onClick={() => onHeading(item)}>
                      <span class="tree-label">{item.title}</span>
                      {count(item)}
                    </button>
                    {rowMenu(
                      `h${item.line}`,
                      item.title,
                      <MenuItem onSelect={() => structure?.onNewSubsection({ line: item.line, title: item.title })}>{a.newSubsectionIn(item.title)}</MenuItem>,
                    )}
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      class="tree-item"
                      aria-label={m.openFile(label(item.path))}
                      title={item.path}
                      onClick={() => onOpenFile(item.path)}
                    >
                      <Icon name="document" />
                      <span class="tree-label">{label(item.path)}</span>
                      {count(item)}
                    </button>
                    {rowMenu(
                      `i${item.line}`,
                      label(item.path),
                      <>
                        {inMain && <MenuItem onSelect={() => structure?.onNewSection(item.line)}>{a.newSectionAfter(label(item.path))}</MenuItem>}
                        <MenuItem onSelect={() => structure?.onNewSubsection({ path: item.path, title: label(item.path) })}>
                          {a.newSubsectionIn(label(item.path))}
                        </MenuItem>
                      </>,
                    )}
                  </>
                )}
              </li>
              {item.kind === 'include' && gap(item.line, `gap-${item.line}`)}
            </Fragment>
          ))}
        </ul>
      )}
      {openPath && items.length === 0 && <p class="muted panel-note">{m.noHeadings}</p>}
      {structure && (
        <button type="button" class="tree-item outline-new" onClick={() => structure.onNewSection()}>
          <span class="outline-add-icon" aria-hidden="true">
            +
          </span>
          <span class="tree-label">{a.newSection}</span>
        </button>
      )}
    </div>
  );
}
