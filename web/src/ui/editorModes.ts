import type { Extension } from '@codemirror/state';
import { Decoration, EditorView, MatchDecorator, ViewPlugin, highlightActiveLine, lineNumbers, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { EditorMode } from '../shell/prefs';
import { highlightStyle } from './editorStyle';

// The two editor looks. Code: monospace, line numbers, full syntax colours.
// Writing: a proportional paper font at 16px with 1.7 line height, lines of
// about 72 characters centred, no gutter, and only quiet hints for headings,
// emphasis, math and citations. Colours are the app's theme tokens.

const codeTheme = EditorView.theme({
  '&': { fontSize: '0.9375rem' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { padding: '0.75rem 0' },
});

const writingTheme = EditorView.theme({
  '&': { fontSize: '16px' },
  '.cm-scroller': { fontFamily: 'var(--font-paper)', lineHeight: '1.7' },
  '.cm-content': { maxWidth: '72ch', margin: '0 auto', padding: '1.5rem 1.25rem 4rem', boxSizing: 'border-box', width: '100%' },
  '.cm-line': { padding: '0' },
  '.cm-w-math': { color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', fontSize: '0.92em' },
  '.cm-w-cite': { color: 'var(--accent)' },
});

/** Headings, emphasis and strong only; Markdown punctuation is muted. */
export const writingHighlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '700', color: 'var(--fg)' },
  { tag: tags.heading1, fontSize: '1.3em' },
  { tag: tags.heading2, fontSize: '1.15em' },
  { tag: tags.heading3, fontSize: '1.05em' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: [tags.processingInstruction, tags.meta, tags.url, tags.comment], color: 'var(--fg-muted)' },
]);

const marks = new MatchDecorator({
  // `$$…$$`, `$…$` and Pandoc citations.
  regexp: /\$\$[^$]+\$\$|\$[^$\n]+\$|(?<![\w@./\\])@[\w][\w:.#$%&\-+?<>~/]*[\w]/g,
  decoration: (m) => Decoration.mark({ class: m[0].startsWith('$') ? 'cm-w-math' : 'cm-w-cite' }),
});

const writingMarks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = marks.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = marks.updateDeco(update, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

export function modeExtension(mode: EditorMode): Extension {
  if (mode === 'writing') {
    return [writingTheme, syntaxHighlighting(writingHighlight), writingMarks, EditorView.editorAttributes.of({ 'data-mode': 'writing' })];
  }
  return [
    codeTheme,
    lineNumbers(),
    highlightActiveLine(),
    syntaxHighlighting(highlightStyle, { fallback: true }),
    EditorView.editorAttributes.of({ 'data-mode': 'code' }),
  ];
}

let vimModule: Promise<typeof import('@replit/codemirror-vim')> | undefined;

/**
 * Vim key bindings, loaded on first use only (about 200 kB unpacked, its own
 * chunk), so people who never turn Vim on never download it.
 */
export function loadVim(): Promise<Extension> {
  vimModule ??= import('@replit/codemirror-vim');
  vimModule.catch(() => (vimModule = undefined));
  return vimModule.then((m) => m.vim());
}
