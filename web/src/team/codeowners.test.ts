import { describe, expect, it } from 'vitest';
import { codeownersPath, matchesPattern, ownersOf, parseCodeowners, setOwners, NEW_CODEOWNERS_PATH } from './codeowners';

describe('CODEOWNERS parsing', () => {
  it('reads patterns and owners, skipping comments, blank and invalid lines', () => {
    const rules = parseCodeowners(
      ['# Owners', '', '*       @ana', '/sections/02-methods.qmd @ben @org/stats # inline', 'docs/* someone@example.com', 'bad.md @not valid!', '!neg @ana', '[ab].md @ana'].join('\n'),
    );
    expect(rules.map((r) => [r.pattern, r.owners, r.line])).toEqual([
      ['*', ['@ana'], 3],
      ['/sections/02-methods.qmd', ['@ben', '@org/stats'], 4],
      ['docs/*', ['someone@example.com'], 5],
    ]);
  });

  it('keeps a pattern without owners (it removes ownership)', () => {
    expect(parseCodeowners('/a.md')).toEqual([{ pattern: '/a.md', owners: [], line: 1 }]);
  });
});

describe('CODEOWNERS patterns (gitignore-like, as GitHub documents)', () => {
  it.each([
    ['*', 'a/b/c.qmd', true],
    ['*.js', 'src/deep/x.js', true],
    ['*.js', 'src/x.ts', false],
    ['/docs/', 'docs/a.md', true],
    ['/docs/', 'docs/sub/a.md', true],
    ['/docs/', 'x/docs/a.md', false],
    ['apps/', 'x/apps/y.md', true],
    ['docs/*', 'docs/getting-started.md', true],
    ['docs/*', 'docs/build-app/troubleshooting.md', false],
    ['**/logs', 'deeply/nested/logs/x.log', true],
    ['/build/logs/', 'build/logs/a/b.log', true],
    ['/sections/02-methods.qmd', 'sections/02-methods.qmd', true],
    ['/sections/02-methods.qmd', 'other/sections/02-methods.qmd', false],
    ['sections', 'sections/a.qmd', true],
    ['sections/a.qmd', 'x/sections/a.qmd', false],
    ['sec?ions/*.qmd', 'sections/a.qmd', true],
    ['docs/**', 'docs/a/b.md', true],
  ])('%s vs %s is %s', (pattern, path, expected) => {
    expect(matchesPattern(pattern, path)).toBe(expected);
  });

  it('the last matching rule wins', () => {
    const rules = parseCodeowners('* @ana\n/sections/ @ben\n/sections/02-methods.qmd @cleo\n');
    expect(ownersOf(rules, 'sections/02-methods.qmd')).toEqual(['@cleo']);
    expect(ownersOf(rules, 'sections/01-intro.qmd')).toEqual(['@ben']);
    expect(ownersOf(rules, 'index.qmd')).toEqual(['@ana']);
    expect(ownersOf(parseCodeowners('/sections/ @ben\n/sections/a.qmd\n'), 'sections/a.qmd')).toEqual([]);
  });

  it('a hostile pattern does not stall', () => {
    const start = Date.now();
    expect(matchesPattern(`${'*'.repeat(150)}b`, 'a'.repeat(200))).toBe(false);
    expect(matchesPattern(Array(60).fill('**').join('/') + '/x', Array(60).fill('a').join('/'))).toBe(false);
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe('CODEOWNERS location', () => {
  it('uses .github/, then the root, then docs/: the first one found', () => {
    expect(codeownersPath(['docs/CODEOWNERS', 'CODEOWNERS', '.github/CODEOWNERS'])).toBe('.github/CODEOWNERS');
    expect(codeownersPath(['docs/CODEOWNERS', 'CODEOWNERS'])).toBe('CODEOWNERS');
    expect(codeownersPath(['docs/CODEOWNERS'])).toBe('docs/CODEOWNERS');
    expect(codeownersPath(['a/CODEOWNERS'])).toBeUndefined();
  });
});

describe('CODEOWNERS edits', () => {
  it('replaces the owners of the exact rule for a section, keeping the rest', () => {
    const text = '# Team\n* @ana\n/sections/a.qmd @ben # methods\n';
    expect(setOwners(text, 'sections/a.qmd', ['@cleo', '@org/stats'])).toBe('# Team\n* @ana\n/sections/a.qmd @cleo @org/stats\n');
  });

  it('appends a rule at the end, so it wins over broader ones', () => {
    expect(setOwners('* @ana', 'sections/b.qmd', ['@ben'])).toBe('* @ana\n/sections/b.qmd @ben\n');
  });

  it('starts a new file with a comment', () => {
    const out = setOwners('', 'sections/b.qmd', ['@ben']);
    expect(out?.startsWith('#')).toBe(true);
    expect(out?.endsWith('/sections/b.qmd @ben\n')).toBe(true);
    expect(NEW_CODEOWNERS_PATH).toBe('.github/CODEOWNERS');
  });

  it('clearing owners removes the exact rules', () => {
    expect(setOwners('* @ana\n/sections/a.qmd @ben\n/sections/a.qmd @cleo\n', 'sections/a.qmd', [])).toBe('* @ana\n');
  });

  it('refuses invalid owners and paths it cannot write', () => {
    expect(setOwners('', 'sections/a.qmd', ['ben'])).toBeUndefined();
    expect(setOwners('', 'sections/a.qmd', ['@bad login'])).toBeUndefined();
    expect(setOwners('', 'my file.qmd', ['@ben'])).toBeUndefined();
    expect(setOwners('', '#x.qmd', ['@ben'])).toBeUndefined();
    expect(setOwners('', 'sections/*.qmd', ['@ben'])).toBeUndefined();
  });
});
