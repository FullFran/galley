import { describe, expect, it } from 'vitest';
import { MAX_EDITABLE, parseConfig, serializeConfig, type GalleyConfig } from './schema';

const errors = (text: string) => parseConfig(text).problems.filter((p) => p.severity === 'error').map((p) => p.message);
const warnings = (text: string) => parseConfig(text).problems.filter((p) => p.severity === 'warning').map((p) => p.message);

const FULL = `version: 1
title: TL glow curve paper
entry: index.qmd
editable:
  - index.qmd
  - sections/*.qmd
uploads:
  - folder: figures/
    accept: [png, JPG, svg]
    max_size_mb: 10
labels:
  sections/01-introduction.qmd: Introduction
preview:
  auto_compile: true
`;

describe('parseConfig: structure', () => {
  it('defaults to write and reads structure: admin', () => {
    expect(parseConfig('version: 1\neditable: []\n').config?.structure).toBeUndefined();
    expect(parseConfig('version: 1\neditable: []\nstructure: admin\n').config?.structure).toBe('admin');
    expect(parseConfig('version: 1\neditable: []\nstructure: write\n').config?.structure).toBe('write');
  });

  it('rejects other values and writes admin back', () => {
    expect(errors('version: 1\neditable: []\nstructure: everyone\n')).toEqual(['"structure" must be admin or write.']);
    const config = parseConfig('version: 1\neditable: []\nstructure: admin\n').config as GalleyConfig;
    expect(serializeConfig(config)).toContain('structure: admin');
    expect(serializeConfig({ ...config, structure: 'write' })).not.toContain('structure');
  });
});

describe('parseConfig: editor', () => {
  it('reads editor.default_mode', () => {
    expect(parseConfig('version: 1\neditable: []\neditor:\n  default_mode: writing\n').config?.editor).toEqual({ defaultMode: 'writing' });
    expect(parseConfig('version: 1\neditable: []\n').config?.editor).toBeUndefined();
  });

  it('ignores an unknown mode with a warning, keeping the rest of the file', () => {
    const text = 'version: 1\neditable: [index.qmd]\neditor:\n  default_mode: vim\n';
    expect(errors(text)).toEqual([]);
    expect(warnings(text)).toEqual(['"editor.default_mode" must be writing or code; it is ignored.']);
    expect(parseConfig(text).config).toMatchObject({ editable: ['index.qmd'], editor: {} });
  });

  it('rejects a non-mapping editor and warns about unknown editor keys', () => {
    expect(errors('version: 1\neditable: []\neditor: code\n')).toEqual(['"editor" must be a mapping.']);
    expect(warnings('version: 1\neditable: []\neditor:\n  font: big\n')).toEqual(['Unknown setting "editor.font" is ignored.']);
  });
});

describe('parseConfig', () => {
  it('reads a complete file', () => {
    const { config, problems } = parseConfig(FULL);
    expect(problems).toEqual([]);
    expect(config).toEqual<GalleyConfig>({
      version: 1,
      title: 'TL glow curve paper',
      entry: 'index.qmd',
      editable: ['index.qmd', 'sections/*.qmd'],
      uploads: [{ folder: 'figures/', accept: ['png', 'jpg', 'svg'], maxSizeMb: 10 }],
      labels: { 'sections/01-introduction.qmd': 'Introduction' },
      preview: { autoCompile: true },
    });
  });

  it('fills defaults for optional fields', () => {
    const { config, problems } = parseConfig('version: 1\neditable: [index.qmd]\n');
    expect(problems).toEqual([]);
    expect(config).toEqual<GalleyConfig>({
      version: 1,
      editable: ['index.qmd'],
      uploads: [],
      labels: {},
      preview: { autoCompile: false },
    });
  });

  it('defaults upload types and size, and adds the trailing slash to folders', () => {
    const { config } = parseConfig('version: 1\neditable: []\nuploads:\n  - folder: figures\n');
    expect(config?.uploads).toEqual([{ folder: 'figures/', accept: ['png', 'jpg', 'jpeg', 'svg', 'pdf'], maxSizeMb: 10 }]);
  });

  it('warns about unknown keys but keeps the rest', () => {
    const text = 'version: 1\neditable: [index.qmd]\nthemes: dark\npreview:\n  auto_compile: false\n  zoom: 2\n';
    const { config } = parseConfig(text);
    expect(config?.editable).toEqual(['index.qmd']);
    expect(warnings(text)).toEqual(['Unknown setting "themes" is ignored.', 'Unknown setting "preview.zoom" is ignored.']);
  });

  it('reports wrong types with the field name', () => {
    expect(errors('version: 1\neditable: index.qmd\n')).toEqual(['"editable" must be a list of file paths or patterns.']);
    expect(errors('version: 1\neditable: [3]\n')).toEqual(['"editable" item 1 must be text.']);
    expect(errors('version: 1\neditable: []\npreview:\n  auto_compile: "yes"\n')).toEqual([
      '"preview.auto_compile" must be true or false.',
    ]);
    expect(errors('version: 1\neditable: []\nuploads:\n  - folder: figures/\n    max_size_mb: big\n')).toEqual([
      '"uploads" item 1: "max_size_mb" must be a number between 0 and 25.',
    ]);
    expect(errors('version: 1\neditable: []\nlabels: [a]\n')).toEqual(['"labels" must map file paths to names.']);
    expect(errors('version: 1\neditable: []\ntitle: [x]\n')).toEqual(['"title" must be text.']);
  });

  it('rejects a missing or unsupported version and a missing editable list', () => {
    expect(errors('editable: []\n')).toEqual(['"version" is missing; use "version: 1".']);
    expect(errors('version: 2\neditable: []\n')).toEqual(['Only "version: 1" is supported.']);
    expect(errors('version: 1\n')).toEqual(['"editable" is missing: list the files co-authors can edit.']);
  });

  it('gives no config at all when anything is an error', () => {
    expect(parseConfig('version: 1\neditable: [../secret]\n').config).toBeUndefined();
  });

  it('rejects patterns and paths that leave the repository', () => {
    expect(errors('version: 1\neditable: [../x.qmd]\n')[0]).toMatch(/^"editable" item 1 \(\.\.\/x\.qmd\): .*\.\./);
    expect(errors('version: 1\neditable: [/etc/passwd]\n')[0]).toMatch(/start with/);
    expect(errors('version: 1\neditable: []\nentry: ../index.qmd\n')[0]).toMatch(/^"entry"/);
    expect(errors('version: 1\neditable: []\nentry: "*.qmd"\n')[0]).toMatch(/^"entry" must be one \.qmd or \.md file/);
    expect(errors('version: 1\neditable: []\nuploads:\n  - folder: ../out/\n')[0]).toMatch(/^"uploads" item 1/);
    expect(errors('version: 1\neditable: []\nuploads:\n  - folder: figures/*\n')[0]).toMatch(/plain folder/);
    expect(errors('version: 1\neditable: []\nuploads:\n  - folder: .github/workflows/\n')[0]).toMatch(/hidden/);
    expect(errors('version: 1\neditable: []\nuploads:\n  - folder: /\n')[0]).toMatch(/^"uploads" item 1/);
    expect(errors('version: 1\neditable: []\nlabels:\n  ../x.qmd: X\n')[0]).toMatch(/^"labels"/);
  });

  it('rejects upload types that are not plain extensions', () => {
    expect(errors('version: 1\neditable: []\nuploads:\n  - folder: f/\n    accept: [".png"]\n')[0]).toMatch(/extension/);
    expect(errors('version: 1\neditable: []\nuploads:\n  - folder: f/\n    accept: ["p/ng"]\n')[0]).toMatch(/extension/);
  });

  it('caps list sizes and text lengths', () => {
    const many = Array.from({ length: MAX_EDITABLE + 1 }, (_, i) => `  - f${i}.qmd`).join('\n');
    expect(errors(`version: 1\neditable:\n${many}\n`)).toEqual([`"editable" lists more than ${MAX_EDITABLE} entries.`]);
    expect(errors(`version: 1\neditable: []\ntitle: ${'x'.repeat(200)}\n`)[0]).toMatch(/longer than 120/);
    expect(errors(`version: 1\neditable: []\nlabels:\n  a.qmd: ${'x'.repeat(200)}\n`)[0]).toMatch(/longer than 120/);
    expect(errors(`version: 1\neditable: []\n# ${'x'.repeat(70 * 1024)}\n`)).toEqual(['.galley.yml is larger than 64 KB.']);
  });

  it('refuses YAML aliases, custom tags, duplicates and non-mappings', () => {
    expect(errors('version: 1\nlist: &a [index.qmd]\neditable: *a\n')[0]).toMatch(/not valid YAML/);
    expect(errors('version: 1\neditable: !!js/function f\n')[0]).toMatch(/not valid YAML/);
    expect(errors('version: 1\nversion: 1\neditable: []\n')[0]).toMatch(/not valid YAML/);
    expect(errors('- a\n- b\n')).toEqual(['.galley.yml must be a mapping of settings (key: value).']);
    expect(errors('')).toEqual(['.galley.yml must be a mapping of settings (key: value).']);
  });

  it('rejects control characters in text', () => {
    expect(errors('version: 1\neditable: []\ntitle: "a\\u0007b"\n')[0]).toMatch(/control/);
  });
});

describe('serializeConfig', () => {
  it('writes keys in a stable order without comments', () => {
    const config: GalleyConfig = {
      preview: { autoCompile: false },
      labels: { 'sections/b.qmd': 'B', 'sections/a.qmd': 'A' },
      uploads: [{ maxSizeMb: 10, accept: ['png', 'pdf'], folder: 'figures/' }],
      editable: ['index.qmd', 'sections/*.qmd'],
      entry: 'index.qmd',
      title: 'Paper: a study',
      version: 1,
    };
    const text = serializeConfig(config);
    expect(text).toBe(`version: 1
title: 'Paper: a study'
entry: index.qmd
editable:
  - index.qmd
  - sections/*.qmd
uploads:
  - folder: figures/
    accept:
      - png
      - pdf
    max_size_mb: 10
labels:
  sections/a.qmd: A
  sections/b.qmd: B
preview:
  auto_compile: false
`);
    expect(text).not.toContain('#');
  });

  it('round-trips through parseConfig', () => {
    const { config } = parseConfig(FULL);
    if (!config) throw new Error('expected a config');
    const again = parseConfig(serializeConfig(config));
    expect(again.problems).toEqual([]);
    expect(again.config).toEqual(config);
    expect(serializeConfig(again.config as GalleyConfig)).toBe(serializeConfig(config));
  });

  it('leaves out empty optional sections', () => {
    expect(serializeConfig({ version: 1, editable: [], uploads: [], labels: {}, preview: { autoCompile: false } })).toBe(
      'version: 1\neditable: []\npreview:\n  auto_compile: false\n',
    );
  });

  it('writes and reads editor.default_mode only when it is set', () => {
    const base: GalleyConfig = { version: 1, editable: [], uploads: [], labels: {}, preview: { autoCompile: false } };
    const text = serializeConfig({ ...base, editor: { defaultMode: 'code' } });
    expect(text).toBe('version: 1\neditable: []\npreview:\n  auto_compile: false\neditor:\n  default_mode: code\n');
    expect(parseConfig(text).config?.editor).toEqual({ defaultMode: 'code' });
    expect(serializeConfig({ ...base, editor: {} })).not.toContain('editor');
  });

  it('quotes text that YAML would read as another type', () => {
    const text = serializeConfig({ version: 1, title: 'yes', editable: ['true'], uploads: [], labels: {}, preview: { autoCompile: false } });
    expect(parseConfig(text).config?.title).toBe('yes');
    expect(parseConfig(text).config?.editable).toEqual(['true']);
  });
});
