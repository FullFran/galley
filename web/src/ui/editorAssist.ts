import type { Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { forceLinting, linter, type Diagnostic } from '@codemirror/lint';
import { completeAt, type CompletionItem } from '../editor/complete';
import { definitionAt, type DefinitionTarget } from '../editor/definition';
import { findRefProblems } from '../editor/diagnose';
import { isText, type LabelKind, type ProjectIndex } from '../editor/projectIndex';
import type { Messages } from '../i18n/en';

// Autocomplete, inline warnings and "go to definition", on top of the
// project index. Everything reads the latest index and catalog through
// getters, so the editor view never has to be rebuilt for them.

export interface AssistOptions {
  path: string;
  /** Undefined until the first index is built; warnings wait for it. */
  index: () => ProjectIndex | undefined;
  t: () => Messages;
  onDefinition: (target: DefinitionTarget) => void;
}

const KIND_NAME: Record<LabelKind, 'figure' | 'table' | 'equation' | 'section'> = {
  fig: 'figure',
  tbl: 'table',
  eq: 'equation',
  sec: 'section',
};

function toCompletion(item: CompletionItem, t: Messages): Completion {
  const detail =
    item.type === 'crossref' && item.kind ? [t.editor[KIND_NAME[item.kind]], item.number].filter(Boolean).join(' ') : item.detail;
  return { label: item.label, type: item.type, detail, info: item.info, boost: item.type === 'crossref' ? 1 : 0 };
}

const VALID: Record<CompletionItem['type'], RegExp> = {
  citation: /^[\w:.#$%&\-+?<>~/]*$/,
  crossref: /^[\w:.#$%&\-+?<>~/]*$/,
  file: /^[^\s"'>]*$/,
  image: /^[^\s)]*$/,
};

/** Checks the warnings again now (the project index changed). */
export const refreshWarnings = (view: EditorView) => forceLinting(view);

export function assistExtension(options: AssistOptions): Extension {
  const prose = isText(options.path);

  const complete = (context: CompletionContext): CompletionResult | null => {
    const index = options.index();
    if (!index) return null;
    const line = context.state.doc.lineAt(context.pos);
    const result = completeAt(line.text, context.pos - line.from, index, options.path);
    if (!result || result.items.length === 0) return null;
    const t = options.t();
    return {
      from: line.from + result.from,
      options: result.items.map((item) => toCompletion(item, t)),
      validFor: VALID[result.items[0]?.type ?? 'citation'],
    };
  };

  const lint = (view: EditorView): Diagnostic[] => {
    const index = options.index();
    if (!index) return [];
    const t = options.t();
    return findRefProblems(view.state.doc.toString(), index).map((p) => ({
      from: p.from,
      to: p.to,
      severity: 'warning',
      message: p.kind === 'unknown-citation' ? t.editor.unknownCitation(p.key) : t.editor.danglingCrossref(p.key),
    }));
  };

  const goTo = (view: EditorView, pos: number): boolean => {
    const index = options.index();
    if (!index) return false;
    const line = view.state.doc.lineAt(pos);
    const target = definitionAt(line.text, pos - line.from, index, options.path);
    if (!target) return false;
    options.onDefinition(target);
    return true;
  };
  const atPointer = (event: MouseEvent, view: EditorView) => {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    return pos !== null && goTo(view, pos);
  };

  if (!prose) return [];
  return [
    autocompletion({ override: [complete], icons: false }),
    linter(lint, { delay: 600 }),
    EditorView.domEventHandlers({
      dblclick: (event, view) => {
        if (!atPointer(event, view)) return false;
        event.preventDefault();
        return true;
      },
      mousedown: (event, view) => {
        if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false;
        if (!atPointer(event, view)) return false;
        event.preventDefault();
        return true;
      },
    }),
    keymap.of([{ key: 'F12', run: (view) => goTo(view, view.state.selection.main.head) }]),
  ];
}
