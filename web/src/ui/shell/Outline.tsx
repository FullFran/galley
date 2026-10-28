import { useT } from '../../i18n';
import type { OutlineItem } from '../../shell/outline';
import { Icon } from './icons';

export interface OutlineProps {
  main?: string;
  openPath?: string;
  items: OutlineItem[];
  label: (path: string) => string;
  onOpenFile: (path: string) => void;
  onHeading: (item: Extract<OutlineItem, { kind: 'heading' }>) => void;
}

/** The Paper panel: the main file pinned first, then the outline of the open file. */
export function Outline({ main, openPath, items, label, onOpenFile, onHeading }: OutlineProps) {
  const m = useT().outline;
  return (
    <div class="outline-panel" data-tour="outline">
      {main && (
        <button
          type="button"
          class="tree-item outline-main"
          aria-current={openPath === main ? 'true' : undefined}
          onClick={() => onOpenFile(main)}
        >
          <Icon name="document" />
          <span class="tree-label">{label(main)}</span>
          <span class="chip">{m.mainFile}</span>
        </button>
      )}
      {openPath && (
        <ul class="outline" aria-label={m.outlineOf(label(openPath))}>
          {items.map((item) => (
            <li key={`${item.line}`} class={item.kind === 'heading' ? `outline-l${Math.min(item.level, 4)}` : 'outline-include'}>
              {item.kind === 'heading' ? (
                <button type="button" class="tree-item" onClick={() => onHeading(item)}>
                  <span class="tree-label">{item.title}</span>
                </button>
              ) : (
                <button type="button" class="tree-item" aria-label={m.openFile(label(item.path))} onClick={() => onOpenFile(item.path)}>
                  <Icon name="document" />
                  <span class="tree-label">{label(item.path)}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {openPath && items.length === 0 && <p class="muted panel-note">{m.noHeadings}</p>}
    </div>
  );
}
