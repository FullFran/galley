import { describe, expect, it } from 'vitest';
import { setSectionStatus } from './configEdit';
import { parseConfig, serializeConfig, type GalleyConfig } from './schema';

const errors = (text: string) => parseConfig(text).problems.filter((p) => p.severity === 'error').map((p) => p.message);
const warnings = (text: string) => parseConfig(text).problems.filter((p) => p.severity === 'warning').map((p) => p.message);

describe('parseConfig: sections', () => {
  it('reads a status per section file', () => {
    const config = parseConfig('version: 1\neditable: []\nsections:\n  sections/02-methods.qmd:\n    status: in_review\n  index.qmd:\n    status: approved\n').config;
    expect(config?.sections).toEqual({ 'sections/02-methods.qmd': { status: 'in_review' }, 'index.qmd': { status: 'approved' } });
  });

  it('absent means no statuses', () => {
    expect(parseConfig('version: 1\neditable: []\n').config?.sections).toBeUndefined();
  });

  it('rejects unknown statuses, wildcards and wrong shapes', () => {
    expect(errors('version: 1\neditable: []\nsections:\n  a.qmd:\n    status: done\n')).toEqual(['"sections" status for a.qmd must be draft, in_review or approved.']);
    expect(errors('version: 1\neditable: []\nsections:\n  "*.qmd":\n    status: draft\n')).toHaveLength(1);
    expect(errors('version: 1\neditable: []\nsections: [a.qmd]\n')).toEqual(['"sections" must map section files to their status.']);
    expect(errors('version: 1\neditable: []\nsections:\n  a.qmd: draft\n')).toEqual(['"sections" entry for a.qmd must be a mapping with a "status".']);
  });

  it('warns about unknown keys inside a section', () => {
    expect(warnings('version: 1\neditable: []\nsections:\n  a.qmd:\n    status: draft\n    owner: ben\n')).toEqual(['sections.a.qmd: unknown setting "owner" is ignored.']);
  });

  it('round-trips through serializeConfig, sorted by path', () => {
    const config = parseConfig('version: 1\neditable: []\nsections:\n  b.qmd:\n    status: draft\n  a.qmd:\n    status: approved\n').config as GalleyConfig;
    const text = serializeConfig(config);
    expect(text).toContain('sections:\n  a.qmd:\n    status: approved\n  b.qmd:\n    status: draft\n');
    expect(parseConfig(text).config?.sections).toEqual(config.sections);
  });
});

describe('setSectionStatus (keeps comments)', () => {
  const TEXT = 'version: 1\n# kept\neditable:\n  - index.qmd\n';

  it('adds a sections block when there is none', () => {
    const out = setSectionStatus(TEXT, 'sections/02-methods.qmd', 'in_review');
    expect(out).toBe(`${TEXT}sections:\n  sections/02-methods.qmd:\n    status: in_review\n`);
    expect(parseConfig(out ?? '').config?.sections).toEqual({ 'sections/02-methods.qmd': { status: 'in_review' } });
  });

  it('changes an existing status in place', () => {
    const text = `${TEXT}sections:\n  a.qmd:\n    status: draft # first\n  b.qmd:\n    status: draft\n`;
    const out = setSectionStatus(text, 'b.qmd', 'approved');
    expect(out).toBe(`${TEXT}sections:\n  a.qmd:\n    status: draft # first\n  b.qmd:\n    status: approved\n`);
  });

  it('adds a new section to an existing block', () => {
    const text = `${TEXT}sections:\n  a.qmd:\n    status: draft\npreview:\n  auto_compile: false\n`;
    const out = setSectionStatus(text, 'b.qmd', 'approved');
    expect(parseConfig(out ?? '').config?.sections).toEqual({ 'a.qmd': { status: 'draft' }, 'b.qmd': { status: 'approved' } });
    expect(out).toContain('preview:\n  auto_compile: false');
  });

  it('gives up on flow style, so the caller rewrites the file', () => {
    expect(setSectionStatus(`${TEXT}sections: {}\n`, 'a.qmd', 'draft')).toBeUndefined();
  });
});
