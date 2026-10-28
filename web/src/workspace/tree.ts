export interface TreeFile {
  kind: 'file';
  name: string;
  path: string;
}

export interface TreeFolder {
  kind: 'folder';
  name: string;
  path: string;
  children: TreeNode[];
}

export type TreeNode = TreeFile | TreeFolder;

/** Builds a folder tree from flat file paths; folders first, then names in order. */
export function buildTree(paths: string[]): TreeNode[] {
  const root: TreeFolder = { kind: 'folder', name: '', path: '', children: [] };
  for (const path of paths) {
    const parts = path.split('/');
    let folder = root;
    parts.slice(0, -1).forEach((name, i) => {
      let next = folder.children.find((c): c is TreeFolder => c.kind === 'folder' && c.name === name);
      if (!next) {
        next = { kind: 'folder', name, path: parts.slice(0, i + 1).join('/'), children: [] };
        folder.children.push(next);
      }
      folder = next;
    });
    folder.children.push({ kind: 'file', name: parts[parts.length - 1] ?? path, path });
  }
  sortFolder(root);
  return root.children;
}

function sortFolder(folder: TreeFolder): void {
  folder.children.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1,
  );
  for (const child of folder.children) if (child.kind === 'folder') sortFolder(child);
}

const DOCUMENT = new Set(['qmd', 'md', 'markdown', 'bib', 'yml', 'yaml']);
const BINARY = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'zip', 'gz', 'tar', 'docx', 'xlsx',
  'pptx', 'odt', 'woff', 'woff2', 'ttf', 'otf', 'mp3', 'mp4', 'mov', 'rds', 'rdata', 'pkl', 'npy',
]);

/** `document`: the paper's own files; `text`: other files that may be text; `binary`: cannot be edited. */
export function fileKind(path: string): 'document' | 'text' | 'binary' {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (DOCUMENT.has(ext)) return 'document';
  if (BINARY.has(ext)) return 'binary';
  return 'text';
}
