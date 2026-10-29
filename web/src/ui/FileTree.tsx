import { useRef, useState } from 'preact/hooks';
import type { UploadRule } from '../config/schema';
import { useT } from '../i18n';
import { buildTree, fileAction, fileKind, type TreeNode } from '../workspace/tree';
import { fileIcon, Icon } from './shell/icons';

export interface FileTreeProps {
  paths: string[];
  openPath?: string;
  dirty: Set<string>;
  /** Friendly names from `.galley.yml`, by path. */
  labels?: Record<string, string>;
  onOpen: (path: string) => void;
  /** Upload folders from `.galley.yml`: they offer Upload and accept dropped files. */
  uploads?: readonly UploadRule[];
  /** New files waiting for the next save (sections, uploads). */
  pending?: Set<string>;
  onUpload?: (folder: string, files: File[]) => void;
  /**
   * Shows a file read-only: images in the figure viewer, PDFs in a new tab.
   * Without it, files in upload folders stay disabled like other binaries.
   */
  onView?: (path: string, as: 'image' | 'pdf') => void;
  /** Admins: any image file opens in the viewer, not only those in upload folders. */
  viewAnyImage?: boolean;
}

export function FileTree(props: FileTreeProps) {
  const folders = props.onUpload ? (props.uploads ?? []).map((u) => u.folder) : [];
  const listed = new Set(props.paths);
  const paths = [...props.paths, ...[...(props.pending ?? [])].filter((p) => !listed.has(p))];
  return (
    <div class="file-tree" role="group" aria-label={useT().nav.files}>
      <Nodes nodes={buildTree(paths, folders)} {...props} />
    </div>
  );
}

const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');

function UploadRow({ rule, onUpload }: { rule: UploadRule; onUpload: (folder: string, files: File[]) => void }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  return (
    <li>
      <button type="button" class="tree-item tree-upload" onClick={() => input.current?.click()}>
        <Icon name="image" />
        <span class="tree-label">{t.authoring.uploadTo(rule.folder)}</span>
      </button>
      <input
        ref={input}
        type="file"
        class="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        multiple
        accept={rule.accept.map((e) => `.${e}`).join(',')}
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = '';
          if (files.length) onUpload(rule.folder, files);
        }}
      />
    </li>
  );
}

function Folder({ node, ...rest }: { node: Extract<TreeNode, { kind: 'folder' }> } & FileTreeProps) {
  const rule = rest.onUpload ? rest.uploads?.find((u) => u.folder === `${node.path}/`) : undefined;
  const [over, setOver] = useState(false);
  const drop = rule &&
    rest.onUpload && {
      onDragOver: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(false);
        const files = [...(e.dataTransfer?.files ?? [])];
        if (files.length) rest.onUpload?.(rule.folder, files);
      },
    };
  return (
    <li class={over ? 'tree-drop-over' : undefined} {...(drop || {})}>
      <details open={rule !== undefined || rest.openPath?.startsWith(`${node.path}/`) || node.children.some((c) => rest.pending?.has(c.path))}>
        <summary class="tree-item">
          <Icon name="folder" />
          <span class="tree-label">{node.name}</span>
        </summary>
        <ul>
          {rule && rest.onUpload && <UploadRow rule={rule} onUpload={rest.onUpload} />}
          <Children nodes={node.children} {...rest} />
        </ul>
      </details>
    </li>
  );
}

function Children({ nodes, ...rest }: { nodes: TreeNode[] } & FileTreeProps) {
  return (
    <>
      {nodes.map((node) =>
        node.kind === 'folder' ? (
          <Folder key={node.path} node={node} {...rest} />
        ) : (
          <FileRow key={node.path} path={node.path} name={node.name} {...rest} />
        ),
      )}
    </>
  );
}

function FileRow({ path, name, ...rest }: { path: string; name: string } & FileTreeProps) {
  const t = useT();
  const action = rest.onView
    ? fileAction(path, { uploadFolders: (rest.uploads ?? []).map((u) => u.folder), anyImage: rest.viewAnyImage })
    : fileKind(path) === 'binary'
      ? { kind: 'none' as const }
      : { kind: 'open' as const };
  const view = action.kind === 'view' ? action.as : undefined;
  return (
    <li>
      <button
        type="button"
        class={`tree-item file file-${fileKind(path)}`}
        disabled={action.kind === 'none'}
        aria-current={path === rest.openPath ? 'true' : undefined}
        title={rest.labels?.[path] ? path : undefined}
        onClick={() => (view ? rest.onView?.(path, view) : rest.onOpen(path))}
      >
        <Icon name={fileIcon(path)} />
        {view && <span class="visually-hidden">{view === 'image' ? t.files.viewFigure : t.files.openPdf} </span>}
        <span class="tree-label">{rest.labels?.[path] ?? name}</span>
        {rest.pending?.has(path) && <span class="muted tree-suffix">{t.authoring.newMark}</span>}
        {(rest.dirty.has(path) || rest.pending?.has(path)) && (
          <>
            <span class="edited-dot" aria-hidden="true" />
            <span class="visually-hidden">{t.files.edited}</span>
          </>
        )}
      </button>
    </li>
  );
}

function Nodes({ nodes, ...rest }: { nodes: TreeNode[] } & FileTreeProps) {
  return (
    <ul>
      <Children nodes={nodes} {...rest} />
    </ul>
  );
}
