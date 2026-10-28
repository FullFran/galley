import { describe, expect, it } from 'vitest';
import type { ProjectConfig } from './project';
import { parseConfig } from './schema';
import { filesInView, readViewAs, writeViewAs } from './viewAs';

const FILES = ['.galley.yml', '.github/workflows/ci.yml', '_quarto.yml', 'index.qmd', 'scripts/build.py', 'sections/01.qmd', 'notes/.hidden/x.md'];
const parsed = parseConfig('version: 1\neditable:\n  - index.qmd\n  - sections/*.qmd\n  - .galley.yml\n');
if (!parsed.config) throw new Error('expected a valid config');
const configured: ProjectConfig = { kind: 'valid', config: parsed.config, problems: parsed.problems };

describe('filesInView', () => {
  it('shows an admin every file in the "all files" mode', () => {
    expect(filesInView(FILES, configured, true, 'all')).toEqual(FILES);
  });

  it('shows an admin exactly the co-author files in the co-author mode', () => {
    const coauthor = filesInView(FILES, configured, false, 'all');
    expect(filesInView(FILES, configured, true, 'coauthor')).toEqual(coauthor);
    expect(coauthor).toEqual(['index.qmd', 'sections/01.qmd']);
  });

  it('uses the same fallback as co-authors when .galley.yml is missing', () => {
    expect(filesInView(FILES, { kind: 'missing' }, true, 'coauthor')).toEqual(['index.qmd', 'sections/01.qmd']);
  });

  it('never widens what a co-author sees, whatever the mode', () => {
    expect(filesInView(FILES, configured, false, 'coauthor')).toEqual(filesInView(FILES, configured, false, 'all'));
  });
});

describe('view mode storage', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } as unknown as Storage;
  };

  it('defaults to all files and is kept per repository', () => {
    const store = memory();
    expect(readViewAs('o/paper', store)).toBe('all');
    writeViewAs('o/paper', 'coauthor', store);
    expect(readViewAs('o/paper', store)).toBe('coauthor');
    expect(readViewAs('o/other', store)).toBe('all');
  });

  it('falls back to all files when storage throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(readViewAs('o/paper', broken)).toBe('all');
    expect(() => writeViewAs('o/paper', 'coauthor', broken)).not.toThrow();
  });
});
