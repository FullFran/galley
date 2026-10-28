import { describe, expect, it } from 'vitest';
import { addEditable, addLabel } from './configEdit';
import { parseConfig } from './schema';

const TEXT = `version: 1
# kept
editable:
  - index.qmd
labels:
  index.qmd: Paper # main
preview:
  auto_compile: false
`;

describe('addLabel', () => {
  it('adds an entry at the end of the labels block and keeps comments', () => {
    const out = addLabel(TEXT, 'sections/_methods.qmd', 'Methods: data');
    expect(out).toContain('# kept');
    expect(out).toContain('index.qmd: Paper # main');
    expect(parseConfig(out ?? '').config?.labels).toEqual({ 'index.qmd': 'Paper', 'sections/_methods.qmd': 'Methods: data' });
  });

  it('adds a labels block when there is none', () => {
    const out = addLabel('version: 1\neditable: [index.qmd]\n', 'a.qmd', 'A');
    expect(parseConfig(out ?? '').config?.labels).toEqual({ 'a.qmd': 'A' });
  });

  it('gives up on a flow-style mapping it cannot extend safely', () => {
    expect(addLabel('version: 1\neditable: []\nlabels: {}\n', 'a.qmd', 'A')).toBeUndefined();
  });
});

describe('addEditable', () => {
  it('adds an item to the editable list', () => {
    const out = addEditable(TEXT, 'sections/_methods.qmd');
    expect(out).toContain('# kept');
    expect(parseConfig(out ?? '').config?.editable).toEqual(['index.qmd', 'sections/_methods.qmd']);
  });

  it('gives up on a flow-style list', () => {
    expect(addEditable('version: 1\neditable: [index.qmd]\n', 'a.qmd')).toBeUndefined();
  });
});
