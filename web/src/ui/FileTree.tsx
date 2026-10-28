import { useT } from '../i18n';
import { buildTree, fileKind, type TreeNode } from '../workspace/tree';
import { fileIcon, Icon } from './shell/icons';

export interface FileTreeProps {
  paths: string[];
  openPath?: string;
  dirty: Set<string>;
  /** Friendly names from `.galley.yml`, by path. */
  labels?: Record<string, string>;
  onOpen: (path: string) => void;
}

export function FileTree(props: FileTreeProps) {
  return (
    <div class="file-tree" role="group" aria-label={useT().nav.files}>
      <Nodes nodes={buildTree(props.paths)} {...props} />
    </div>
  );
}

function Nodes({ nodes, ...rest }: { nodes: TreeNode[] } & FileTreeProps) {
  const t = useT();
  return (
    <ul>
      {nodes.map((node) =>
        node.kind === 'folder' ? (
          <li key={node.path}>
            <details open={rest.openPath?.startsWith(`${node.path}/`)}>
              <summary class="tree-item">
                <Icon name="folder" />
                <span class="tree-label">{node.name}</span>
              </summary>
              <Nodes nodes={node.children} {...rest} />
            </details>
          </li>
        ) : (
          <li key={node.path}>
            <button
              type="button"
              class={`tree-item file file-${fileKind(node.path)}`}
              disabled={fileKind(node.path) === 'binary'}
              aria-current={node.path === rest.openPath ? 'true' : undefined}
              title={rest.labels?.[node.path] ? node.path : undefined}
              onClick={() => rest.onOpen(node.path)}
            >
              <Icon name={fileIcon(node.path)} />
              <span class="tree-label">{rest.labels?.[node.path] ?? node.name}</span>
              {rest.dirty.has(node.path) && (
                <>
                  <span class="edited-dot" aria-hidden="true" />
                  <span class="visually-hidden">{t.files.edited}</span>
                </>
              )}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}
