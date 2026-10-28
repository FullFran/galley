import { useEffect, useRef } from 'preact/hooks';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting } from '@codemirror/language';
import { markdownKeymap } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { highlightStyle, markdownSupport } from './editorStyle';

export interface EditorProps {
  path: string;
  /** Initial text; later changes are ignored, so render with `key={path}`. */
  doc: string;
  onChange: (text: string) => void;
  /** Moves the cursor to this line and scrolls it to the top; `seq` changes for every jump. */
  jumpTo?: { line: number; seq: number };
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
  '&': { flex: '1 1 auto', minWidth: '0', height: '100%', fontSize: '0.9375rem', color: 'var(--fg)', backgroundColor: 'var(--surface)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': { padding: '0.75rem 0', caretColor: 'var(--fg)' },
  '.cm-cursor': { borderLeftColor: 'var(--fg)' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--fg-muted)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection)' },
});

/** CodeMirror 6 editor. Owns the EditorView for its lifetime. */
export function Editor({ path, doc, onChange, jumpTo }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>(undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const root = host.current.shadowRoot ?? host.current.attachShadow({ mode: 'open' });
    const view = new EditorView({
      root,
      parent: root,
      state: EditorState.create({
        doc,
        extensions: [
          theme,
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          syntaxHighlighting(highlightStyle, { fallback: true }),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          language(path),
          EditorView.contentAttributes.of({ 'aria-label': `Contents of ${path}` }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      viewRef.current = undefined;
      view.destroy();
    };
    // The view is created once per mount; the parent remounts it per file.
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !jumpTo) return;
    const line = view.state.doc.line(Math.min(Math.max(1, jumpTo.line), view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 16 }) });
    view.focus();
  }, [jumpTo?.seq]);

  return <div class="editor" ref={host} />;
}
