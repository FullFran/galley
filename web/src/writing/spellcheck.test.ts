import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { paperLanguage, spellcheckAttributes, spellcheckExtension } from './spellcheck';

describe('paperLanguage', () => {
  it('reads lang from _quarto.yml, then from the main file’s front matter', () => {
    expect(paperLanguage('project:\n  type: default\nlang: es\n', undefined)).toBe('es');
    expect(paperLanguage('lang: "en-GB"\n', '---\nlang: fr\n---\n')).toBe('en-GB');
    expect(paperLanguage(undefined, '---\ntitle: x\nlang: de-AT\n---\n# Body\n')).toBe('de-AT');
    expect(paperLanguage('format:\n  html:\n    lang: es\n', '# no front matter\nlang: es\n')).toBeUndefined();
  });

  it('ignores values that are not language tags', () => {
    expect(paperLanguage('lang: "es; drop"\n', undefined)).toBeUndefined();
    expect(paperLanguage('lang: 12\n', undefined)).toBeUndefined();
  });
});

describe('spellcheckAttributes', () => {
  it('turns the browser spellcheck on in Writing mode only, with the paper language', () => {
    expect(spellcheckAttributes('writing', true, 'es')).toEqual({ spellcheck: 'true', lang: 'es' });
    expect(spellcheckAttributes('code', true, 'es')).toEqual({ spellcheck: 'false' });
    expect(spellcheckAttributes('writing', false, 'es')).toEqual({ spellcheck: 'false' });
  });

  it('sets the attributes on the CodeMirror content element', () => {
    const state = EditorState.create({ doc: 'Hola', extensions: [spellcheckExtension('writing', true, 'es')] });
    const attrs = state.facet(EditorView.contentAttributes);
    expect(attrs).toContainEqual({ spellcheck: 'true', lang: 'es' });
  });
});
