import { useEffect, useRef } from 'preact/hooks';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdownKeymap } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { markdownSupport } from './editorStyle';
import { loadVim, modeExtension } from './editorModes';
import { vimSave } from './vimCommands';
import type { AssistOptions } from './editorAssist';
import { commentsExtension, setCommentMarks, type CommentHandlers, type CommentMark } from './editorComments';

type AssistModule = typeof import('./editorAssist');
let assistChunk: Promise<AssistModule> | undefined;
const loadAssist = () => {
  assistChunk ??= import('./editorAssist');
  assistChunk.catch(() => (assistChunk = undefined));
  return assistChunk;
};
const isProse = (path: string) => /\.(qmd|md|markdown)$/i.test(path);
import type { EditorMode } from '../shell/prefs';
import { en } from '../i18n/en';

export interface EditorProps {
  path: string;
  /** Accessible name of the text area ("Contents of index.qmd"). */
  label: string;
  /** Initial text; later changes are ignored, so render with `key={path}`. */
  doc: string;
  onChange: (text: string) => void;
  /** Moves the cursor to this line and scrolls it to the top; `seq` changes for every jump. */
  jumpTo?: { line: number; seq: number };
  mode?: EditorMode;
  /** Vim key bindings; the Vim package loads only when this is true. */
  vim?: boolean;
  onVimFailed?: () => void;
  /** Vim `:w`, `:wq` and `:x`: open Save for review. */
  onSave?: () => void;
  /** Autocomplete, warnings and go to definition. */
  assist?: Omit<AssistOptions, 'path'>;
  /** Changes when the project index is rebuilt, so warnings are checked again. */
  indexVersion?: number;
  /** Comment actions and the lines that have open threads. */
  comments?: CommentHandlers & { marks: CommentMark[] };
  /** A change applied as an ordinary edit (undoable); `seq` changes for every edit. */
  applyEdit?: { from: number; to: number; insert: string; seq: number };
  /** Files dropped onto the text, with the document position of the drop. */
  onDropFiles?: (files: File[], pos: number) => void;
  /**
   * Inserts `text` at `at` (or the cursor); `seq` changes for every insertion.
   * `block` puts it in a paragraph of its own (a figure).
   */
  insert?: { text: string; at?: number; block?: boolean; seq: number };
  /** The live view while mounted (undefined once destroyed), for the symbol palette. */
  onView?: (view: EditorView | undefined) => void;
}

function language(path: string): Extension {
  if (/\.(qmd|md|markdown)$/i.test(path)) return [markdownSupport, keymap.of(markdownKeymap)];
  if (/\.ya?ml$/i.test(path)) return yaml();
  return [];
}

// CodeMirror injects its styles at runtime through style-mod. In a document,
// style-mod uses a <style> element, which the production CSP (`style-src
// 'self'`) blocks. Inside a shadow root it uses a constructed stylesheet
// (adoptedStyleSheets) instead, which CSP does not restrict. So the editor
// lives in a shadow root, and its own styling goes through EditorView.theme.
// Colours are the app's CSS custom properties, which inherit into the shadow
// root, so the editor follows the light and dark themes.
const theme = EditorView.theme({
  '&': { flex: '1 1 auto', minWidth: '0', height: '100%', color: 'var(--fg)', backgroundColor: 'var(--surface)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--fg)' },
  '.cm-cursor': { borderLeftColor: 'var(--fg)' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--fg-muted)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection)' },
  // Autocomplete and lint tooltips, in the theme's colours.
  '.cm-tooltip': {
    backgroundColor: 'var(--surface)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    fontFamily: 'var(--font-sans)',
    fontSize: '0.875rem',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-sans)', maxHeight: '16rem' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '0.2rem 0.6rem' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--accent-fg)' },
  '.cm-completionDetail': { marginLeft: '0.75em', fontStyle: 'normal', opacity: '0.75' },
  '.cm-completionInfo': { padding: '0.4rem 0.6rem', maxWidth: '22rem' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--warn-fg)', textUnderlineOffset: '3px' },
  '.cm-diagnostic-warning': { borderLeft: '4px solid var(--warn-fg)' },
  '.cm-diagnostic': { padding: '0.3rem 0.6rem' },
});

/** CodeMirror 6 editor. Owns the EditorView for its lifetime. */
export function Editor({ path, label, doc, onChange, jumpTo, mode = 'code', vim = false, onVimFailed, onSave, assist, indexVersion, onDropFiles, insert, comments, applyEdit, onView }: EditorProps) {
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const commenting = useRef(new Compartment());
  const commentExtension = (m: EditorMode): Extension =>
    commentsRef.current
      ? commentsExtension(m, {
          onComment: (...a) => commentsRef.current?.onComment(...a),
          onOpenThread: (id) => commentsRef.current?.onOpenThread(id),
          onShowInPreview: (line) => commentsRef.current?.onShowInPreview(line),
          labels: () => commentsRef.current?.labels() ?? { comment: '', showInPreview: '', thread: '' },
        })
      : [];
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>(undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const assistRef = useRef(assist);
  assistRef.current = assist;
  const onVimFailedRef = useRef(onVimFailed);
  onVimFailedRef.current = onVimFailed;
  const onDropRef = useRef(onDropFiles);
  onDropRef.current = onDropFiles;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  // The accessible name, the mode and Vim change without recreating the view.
  const labelling = useRef(new Compartment());
  const looks = useRef(new Compartment());
  const keys = useRef(new Compartment());
  const helpers = useRef(new Compartment());
  const assistModule = useRef<AssistModule>(undefined);
  const named = (name: string) => EditorView.contentAttributes.of({ 'aria-label': name });

  useEffect(() => {
    if (!host.current) return;
    const root = host.current.shadowRoot ?? host.current.attachShadow({ mode: 'open' });
    const view = new EditorView({
      root,
      parent: root,
      state: EditorState.create({
        doc,
        extensions: [
          // Vim first, so its keys win over the default keymap.
          keys.current.of([]),
          vimSave.of(() => onSaveRef.current?.()),
          theme,
          looks.current.of(modeExtension(mode)),
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          helpers.current.of([]),
          commenting.current.of(commentExtension(mode)),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          language(path),
          labelling.current.of(named(label)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          // Dropped files (figures) go to the parent with the drop position;
          // dropped text keeps CodeMirror's own handling.
          EditorView.domEventHandlers({
            drop(event, view) {
              const files = [...(event.dataTransfer?.files ?? [])];
              if (files.length === 0 || !onDropRef.current) return false;
              event.preventDefault();
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
              onDropRef.current(files, pos);
              return true;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    onViewRef.current?.(view);
    // Autocomplete, warnings and go to definition load after the first paint,
    // in their own chunk, and only for Markdown files.
    let alive = true;
    if (isProse(path)) {
      void loadAssist().then((m) => {
        if (!alive) return;
        assistModule.current = m;
        view.dispatch({
          effects: helpers.current.reconfigure(
            m.assistExtension({
              path,
              index: () => assistRef.current?.index(),
              t: () => assistRef.current?.t() ?? en,
              onDefinition: (target) => assistRef.current?.onDefinition(target),
            }),
          ),
        });
      }, () => undefined);
    }
    return () => {
      alive = false;
      viewRef.current = undefined;
      onViewRef.current?.(undefined);
      view.destroy();
    };
    // The view is created once per mount; the parent remounts it per file.
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: labelling.current.reconfigure(named(label)) });
  }, [label]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [looks.current.reconfigure(modeExtension(mode)), commenting.current.reconfigure(commentExtension(mode))],
    });
  }, [mode]);

  const marks = comments?.marks;
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setCommentMarks.of(marks ?? []) });
  }, [marks]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !applyEdit) return;
    const length = view.state.doc.length;
    if (applyEdit.from < 0 || applyEdit.to > length || applyEdit.to < applyEdit.from) return;
    view.dispatch({ changes: { from: applyEdit.from, to: applyEdit.to, insert: applyEdit.insert }, userEvent: 'input.suggestion' });
    view.focus();
  }, [applyEdit?.seq]);

  useEffect(() => {
    if (!vim) {
      viewRef.current?.dispatch({ effects: keys.current.reconfigure([]) });
      return;
    }
    let current = true;
    loadVim().then(
      (extension) => {
        if (current) viewRef.current?.dispatch({ effects: keys.current.reconfigure(extension) });
      },
      () => onVimFailedRef.current?.(),
    );
    return () => {
      current = false;
    };
  }, [vim]);

  useEffect(() => {
    if (viewRef.current && indexVersion !== undefined) assistModule.current?.refreshWarnings(viewRef.current);
  }, [indexVersion]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !jumpTo) return;
    const line = view.state.doc.line(Math.min(Math.max(1, jumpTo.line), view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 16 }) });
    view.focus();
  }, [jumpTo?.seq]);

  // An insertion made before this editor mounted (another file) is not repeated here.
  const insertedSeq = useRef(insert?.seq);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !insert || insert.seq === insertedSeq.current) return;
    insertedSeq.current = insert.seq;
    const doc = view.state.doc;
    const at = Math.min(Math.max(0, insert.at ?? view.state.selection.main.head), doc.length);
    let text = insert.text;
    let caret = text.length;
    if (insert.block) {
      const before = doc.sliceString(Math.max(0, at - 2), at);
      const after = doc.sliceString(at, at + 2);
      const lead = at === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      const tail = at === doc.length ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
      text = `${lead}${text}${tail}`;
      caret = text.length;
    }
    view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + caret }, scrollIntoView: true });
    view.focus();
  }, [insert?.seq]);

  return <div class="editor" ref={host} data-mode={mode} />;
}
