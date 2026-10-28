import { buildTree, fileKind, type TreeNode } from '../workspace/tree';

export interface FileTreeProps {
  paths: string[];
  openPath?: string;
  dirty: Set<string>;
  onOpen: (path: string) => void;
}

export function FileTree({ paths, openPath, dirty, onOpen }: FileTreeProps) {
  return (
    <nav class="file-tree" aria-label="Files">
      <Nodes nodes={buildTree(paths)} openPath={openPath} dirty={dirty} onOpen={onOpen} />
    </nav>
  );
}

function Nodes({ nodes, ...rest }: { nodes: TreeNode[] } & Omit<FileTreeProps, 'paths'>) {
  return (
    <ul>
      {nodes.map((node) =>
        node.kind === 'folder' ? (
          <li key={node.path}>
            <details open={rest.openPath?.startsWith(`${node.path}/`)}>
              <summary>{node.name}</summary>
              <Nodes nodes={node.children} {...rest} />
            </details>
          </li>
        ) : (
          <li key={node.path}>
            <button
              type="button"
              class={`file file-${fileKind(node.path)}`}
              disabled={fileKind(node.path) === 'binary'}
              aria-current={node.path === rest.openPath ? 'true' : undefined}
              onClick={() => rest.onOpen(node.path)}
            >
              {node.name}
              {rest.dirty.has(node.path) && <span class="edited"> (edited)</span>}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}
