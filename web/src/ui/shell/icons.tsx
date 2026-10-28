// Inline SVG icons, drawn on a 24px grid with the current text colour. They
// are decorative (aria-hidden): the button or link around them carries the name.

export type IconId =
  | 'library' | 'outline' | 'folder' | 'proposals' | 'settings' | 'help' | 'info' | 'menu' | 'panel'
  | 'close' | 'logout' | 'file' | 'document' | 'image' | 'bib' | 'chevron' | 'github' | 'dots' | 'selector' | 'eye' | 'comment' | 'chat';

const PATHS: Record<IconId, string[]> = {
  library: ['M4 4h4v16H4z', 'M10 4h4v16h-4z', 'M16.5 4.5l3.5 1-4 15-3.5-1'],
  outline: ['M4 6h16', 'M8 12h12', 'M8 18h12', 'M4 12h.01', 'M4 18h.01'],
  folder: ['M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z'],
  proposals: ['M6 3v12', 'M6 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M18 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M18 8v2a5 5 0 0 1-5 5H6'],
  settings: ['M4 7h10', 'M18 7h2', 'M4 17h2', 'M10 17h10', 'M16 5v4', 'M8 15v4'],
  help: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7', 'M12 17h.01'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5', 'M12 8h.01'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  panel: ['M4 4h16v16H4z', 'M9 4v16'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  logout: ['M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  file: ['M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z', 'M14 3v5h5'],
  document: ['M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z', 'M14 3v5h5', 'M8.5 13h7', 'M8.5 17h5'],
  image: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 2-2 5 5', 'M15.5 9.5h.01'],
  bib: ['M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z', 'M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3', 'M9 7h6'],
  chevron: ['M6 9l6 6 6-6'],
  dots: ['M5 11a1 1 0 1 0 0 2 1 1 0 1 0 0-2z', 'M12 11a1 1 0 1 0 0 2 1 1 0 1 0 0-2z', 'M19 11a1 1 0 1 0 0 2 1 1 0 1 0 0-2z'],
  selector: ['M8 9l4-4 4 4', 'M16 15l-4 4-4-4'],
  comment: ['M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4 4v-4h-.5A1.5 1.5 0 0 1 4 14.5z', 'M8 9h8', 'M8 12h5'],
  chat: ['M4 6.5A1.5 1.5 0 0 1 5.5 5h9A1.5 1.5 0 0 1 16 6.5v5a1.5 1.5 0 0 1-1.5 1.5H9l-3 3v-3h-.5A1.5 1.5 0 0 1 4 11.5z', 'M18 9h.5A1.5 1.5 0 0 1 20 10.5v5a1.5 1.5 0 0 1-1.5 1.5H18v3l-3-3h-4.5'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  github: ['M9 19c-4 1.5-4-2-6-2.5', 'M15 21v-3.5a3 3 0 0 0-.9-2.3c3-.3 6-1.5 6-6.5a5 5 0 0 0-1.4-3.5 4.7 4.7 0 0 0-.1-3.5s-1.1-.3-3.6 1.4a12.3 12.3 0 0 0-6.4 0C6.1 1.4 5 1.7 5 1.7a4.7 4.7 0 0 0-.1 3.5A5 5 0 0 0 3.5 8.7c0 5 3 6.2 6 6.5a3 3 0 0 0-.9 2.3V21'],
};

export function Icon({ name, class: className }: { name: IconId; class?: string }) {
  return (
    <svg
      class={className ? `icon ${className}` : 'icon'}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** The icon for a file in the tree, by extension. */
export function fileIcon(path: string): IconId {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (['qmd', 'md', 'markdown'].includes(ext)) return 'document';
  if (ext === 'bib') return 'bib';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf'].includes(ext)) return 'image';
  return 'file';
}
