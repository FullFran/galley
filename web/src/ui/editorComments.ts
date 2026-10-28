import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutter,
  keymap,
  showTooltip,
  type DecorationSet,
  type Tooltip,
} from '@codemirror/view';
import type { EditorMode } from '../shell/prefs';

// Comments in the editor: a floating "Comment" button over a selection
// (also Ctrl/Cmd+Alt+M), "Show in preview" (Ctrl/Cmd+Alt+P), and markers for
// lines with open threads: a gutter dot in Code mode, a subtle highlight in
// Writing mode. Clicking a marker opens its thread. Thread text never enters
// the editor; markers only carry thread ids.

export interface CommentMark {
  threadId: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  unread: boolean;
}

export interface CommentHandlers {
  /** Start a comment on from..to (an empty range: the cursor's line). */
  onComment: (doc: string, from: number, to: number) => void;
  onOpenThread: (threadId: string) => void;
  onShowInPreview: (line: number) => void;
  labels: () => { comment: string; showInPreview: string; thread: string };
}

export const setCommentMarks = StateEffect.define<CommentMark[]>();

const marksField = StateField.define<CommentMark[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setCommentMarks)) return e.value;
    return value;
  },
});

const clampLine = (state: EditorState, n: number) => Math.min(Math.max(1, n), state.doc.lines);

class ThreadMarker extends GutterMarker {
  constructor(
    readonly ids: string[],
    readonly unread: boolean,
    readonly label: string,
  ) {
    super();
  }

  override eq(other: ThreadMarker) {
    return other.ids.join() === this.ids.join() && other.unread === this.unread;
  }

  override toDOM() {
    const el = document.createElement('span');
    el.className = this.unread ? 'cm-comment-dot cm-comment-dot-unread' : 'cm-comment-dot';
    el.textContent = '●';
    el.title = this.label;
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
}

function lineMarks(state: EditorState, label: string) {
  const byLine = new Map<number, { ids: string[]; unread: boolean }>();
  for (const m of state.field(marksField)) {
    const line = clampLine(state, m.startLine);
    const entry = byLine.get(line) ?? { ids: [], unread: false };
    entry.ids.push(m.threadId);
    entry.unread ||= m.unread;
    byLine.set(line, entry);
  }
  const builder = new RangeSetBuilder<GutterMarker>();
  for (const line of [...byLine.keys()].sort((a, b) => a - b)) {
    const e = byLine.get(line);
    if (e) builder.add(state.doc.line(line).from, state.doc.line(line).from, new ThreadMarker(e.ids, e.unread, label));
  }
  return builder.finish();
}

function highlights(state: EditorState): DecorationSet {
  const ranges: { from: number; to: number; id: string }[] = [];
  for (const m of state.field(marksField)) {
    const from = state.doc.line(clampLine(state, m.startLine)).from;
    const to = state.doc.line(clampLine(state, m.endLine)).to;
    if (to > from) ranges.push({ from, to, id: m.threadId });
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, Decoration.mark({ class: 'cm-comment-mark', attributes: { 'data-thread': r.id } }));
  return builder.finish();
}

const commentTheme = EditorView.theme({
  '.cm-comment-gutter': { width: '1.1rem', cursor: 'pointer' },
  '.cm-comment-dot': { color: 'var(--accent)', fontSize: '0.75rem', lineHeight: 'inherit', cursor: 'pointer' },
  '.cm-comment-dot-unread': { color: 'var(--warn-fg)' },
  '.cm-comment-mark': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 12%, transparent)',
    borderBottom: '2px solid color-mix(in srgb, var(--accent) 45%, transparent)',
    cursor: 'pointer',
  },
  '.cm-tooltip.cm-comment-actions': { display: 'flex', gap: '0.25rem', padding: '0.2rem', border: '1px solid var(--border)' },
  '.cm-comment-actions button': {
    font: 'inherit',
    fontSize: '0.8125rem',
    padding: '0.2rem 0.55rem',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    background: 'var(--surface)',
    color: 'var(--fg)',
    cursor: 'pointer',
  },
  '.cm-comment-actions button:first-child': { background: 'var(--accent)', color: 'var(--accent-fg)', borderColor: 'var(--accent)' },
});

const commentOn = (view: EditorView, handlers: CommentHandlers) => {
  const { from, to } = view.state.selection.main;
  handlers.onComment(view.state.doc.toString(), from, to);
  return true;
};
const showInPreview = (view: EditorView, handlers: CommentHandlers) => {
  handlers.onShowInPreview(view.state.doc.lineAt(view.state.selection.main.head).number);
  return true;
};

function actionsTooltip(handlers: CommentHandlers) {
  return StateField.define<readonly Tooltip[]>({
    create: () => [],
    update(value, tr) {
      if (!tr.docChanged && !tr.selection) return value;
      const sel = tr.state.selection.main;
      if (sel.empty) return [];
      return [
        {
          pos: sel.head,
          above: sel.head === sel.from,
          arrow: false,
          create: (view) => {
            const dom = document.createElement('div');
            dom.className = 'cm-comment-actions';
            const labels = handlers.labels();
            const button = (text: string, kbd: string, run: () => void) => {
              const b = document.createElement('button');
              b.type = 'button';
              b.textContent = text;
              b.title = kbd;
              // mousedown would move the selection before click fires.
              b.addEventListener('mousedown', (e) => e.preventDefault());
              b.addEventListener('click', run);
              dom.append(b);
            };
            button(labels.comment, 'Ctrl/Cmd+Alt+M', () => commentOn(view, handlers));
            button(labels.showInPreview, 'Ctrl/Cmd+Alt+P', () => showInPreview(view, handlers));
            dom.setAttribute('data-tour', 'comment-selection');
            return { dom };
          },
        },
      ];
    },
    provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
  });
}

/** The comment extension for one editor mode. Marks arrive through `setCommentMarks`. */
export function commentsExtension(mode: EditorMode, handlers: CommentHandlers): Extension {
  const open = (target: EventTarget | null) => {
    const el = (target as Element | null)?.closest?.('[data-thread]');
    const id = el?.getAttribute('data-thread');
    if (id) handlers.onOpenThread(id);
    return !!id;
  };
  const shared: Extension[] = [
    marksField,
    commentTheme,
    actionsTooltip(handlers),
    keymap.of([
      { key: 'Mod-Alt-m', run: (view) => commentOn(view, handlers) },
      { key: 'Mod-Alt-p', run: (view) => showInPreview(view, handlers) },
    ]),
  ];
  if (mode === 'writing') {
    return [
      ...shared,
      EditorView.decorations.compute([marksField, 'doc'], highlights),
      EditorView.domEventHandlers({
        click: (event, view) => (view.state.selection.main.empty ? open(event.target) : false),
      }),
    ];
  }
  return [
    ...shared,
    gutter({
      class: 'cm-comment-gutter',
      markers: (view) => lineMarks(view.state, handlers.labels().thread),
      domEventHandlers: {
        mousedown: (view, block) => {
          const line = view.state.doc.lineAt(block.from).number;
          const mark = view.state.field(marksField).find((m) => clampLine(view.state, m.startLine) === line);
          if (mark) handlers.onOpenThread(mark.threadId);
          return !!mark;
        },
      },
    }),
  ];
}

