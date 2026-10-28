import { useEffect, useRef } from 'preact/hooks';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdownKeymap } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { markdownSupport } from './editorStyle';
import { loadVim, modeExtension } from './editorModes';
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
  /** Autocomplete, warnings and go to definition. */
  assist?: Omit<AssistOptions, 'path'>;
  /** Changes when the project index is rebuilt, so warnings are checked again. */
  indexVersion?: number;
  /** Comment actions and the lines that have open threads. */
  comments?: CommentHandlers & { marks: CommentMark[] };
  /** A change applied as an ordinary edit (undoable); `seq` changes for every edit. */
  applyEdit?: { from: number; to: number; insert: string; seq: number };
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
export function Editor({ path, label, doc, onChange, jumpTo, mode = 'code', vim = false, onVimFailed, assist, indexVersion, comments, applyEdit }: EditorProps) {
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
        ],
      }),
    });
    viewRef.current = view;
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

  return <div class="editor" ref={host} data-mode={mode} />;
}
