import { describe, expect, it, vi } from 'vitest';
import { compileQuery, expandReplacement, findInFiles, replaceMatches, undoable, type FindOptions } from './findAll';
import { createFindRunner, parseFindRequest, type FindWorkerLike } from './findRunner';

const must = <T,>(value: T | undefined | null): T => {
  if (value === undefined || value === null) throw new Error('missing');
  return value;
};

const opts = (query: string, more: Partial<FindOptions> = {}): FindOptions => ({
  query,
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  ...more,
});

const FILES = [
  { path: 'index.qmd', text: '# Intro\n\nThe glow curve.\nAnother Glow line.\nEnd\n' },
  { path: 'sections/methods.qmd', text: 'Glowing results\nno match here\nglow\n' },
  { path: 'refs.bib', text: '@misc{x}\n' },
];

describe('compileQuery', () => {
  it('escapes plain text and honours match case and whole word', () => {
    const plain = compileQuery(opts('a.b'));
    expect(plain.ok && plain.re.test('a.b') && !plain.re.test('axb')).toBe(true);
    const cased = compileQuery(opts('Glow', { caseSensitive: true }));
    expect(cased.ok && cased.re.flags.includes('i')).toBe(false);
    const word = compileQuery(opts('glow', { wholeWord: true }));
    expect(word.ok && 'glowing'.match(word.re)).toBeNull();
  });

  it('reports empty and invalid patterns instead of throwing', () => {
    expect(compileQuery(opts(''))).toEqual({ ok: false, error: 'empty' });
    expect(compileQuery(opts('(', { regex: true }))).toEqual({ ok: false, error: 'invalid' });
  });
});

describe('findInFiles', () => {
  it('groups matches by file with line, column and context lines', () => {
    const result = findInFiles(FILES, opts('glow'), { context: 1 });
    expect(result.files.map((f) => f.path)).toEqual(['index.qmd', 'sections/methods.qmd']);
    expect(result.total).toBe(4);
    const first = result.files[0]?.matches[0];
    expect(first).toMatchObject({ line: 3, column: 4, text: 'glow', lineText: 'The glow curve.', before: [''], after: ['Another Glow line.'] });
    expect(FILES[0]?.text.slice(first?.from, first?.to)).toBe('glow');
  });

  it('supports match case, whole word and regular expressions', () => {
    expect(findInFiles(FILES, opts('Glow', { caseSensitive: true })).total).toBe(2);
    expect(findInFiles(FILES, opts('glow', { wholeWord: true })).total).toBe(3);
    const re = findInFiles(FILES, opts('^gl\\w+', { regex: true, caseSensitive: true }));
    expect(re.files.map((f) => [f.path, f.matches.map((m) => m.text)])).toEqual([['sections/methods.qmd', ['glow']]]);
  });

  it('skips empty matches without looping and stops at the match limit', () => {
    expect(findInFiles(FILES, opts('x*', { regex: true })).total).toBe(1);
    const capped = findInFiles(FILES, opts('o'), { maxMatches: 3 });
    expect(capped.total).toBe(3);
    expect(capped.truncated).toBe(true);
  });

  it('stops when the deadline passes', () => {
    let calls = 0;
    const result = findInFiles(FILES, opts('e'), { deadline: () => ++calls > 2 });
    expect(result.timedOut).toBe(true);
  });
});

describe('expandReplacement', () => {
  it('expands groups in regex mode and keeps text literal otherwise', () => {
    const m = must(/(\w+)-(?<n>\d+)/.exec('item-42'));
    expect(expandReplacement('$2:$1:$<n>:$&:$$', m, true)).toBe('42:item:42:item-42:$');
    expect(expandReplacement('$1 stays', m, false)).toBe('$1 stays');
  });
});

describe('replaceMatches', () => {
  const text = 'a glow, a Glow, a glow.';
  it('replaces the given matches only, from the end, with groups', () => {
    const found = findInFiles([{ path: 'f', text }], opts('(g)low', { regex: true })).files[0]?.matches ?? [];
    const out = replaceMatches(text, [must(found[0]), must(found[2])], opts('(g)low', { regex: true }), '$1leam');
    expect(out).toEqual({ text: 'a gleam, a Glow, a gleam.', replaced: 2, stale: 0 });
  });

  it('skips matches whose text moved since the search', () => {
    const found = findInFiles([{ path: 'f', text }], opts('glow')).files[0]?.matches ?? [];
    const out = replaceMatches(`X${text}`, found, opts('glow'), 'shine');
    expect(out.replaced).toBe(0);
    expect(out.stale).toBe(3);
  });
});

describe('undoable', () => {
  it('restores only files that still hold the replaced text', () => {
    const steps = [
      { path: 'a', before: 'old a', after: 'new a' },
      { path: 'b', before: 'old b', after: 'new b' },
    ];
    expect(undoable(steps, (p) => (p === 'a' ? 'new a' : 'edited b'))).toEqual({ restore: [{ path: 'a', text: 'old a' }], changed: ['b'] });
  });
});

describe('find runner (regex in a worker with a timeout)', () => {
  const fakeWorker = () => {
    const worker: FindWorkerLike & { sent: unknown[]; terminated: boolean } = {
      sent: [],
      terminated: false,
      onmessage: null,
      postMessage(data: unknown) {
        this.sent.push(data);
      },
      terminate() {
        this.terminated = true;
      },
    };
    return worker;
  };

  it('resolves with the worker result', async () => {
    const w = fakeWorker();
    const run = createFindRunner(() => w, 1000);
    const pending = run(FILES, opts('glow'));
    const req = w.sent[0] as { id: number };
    w.onmessage?.({ data: { id: req.id, result: findInFiles(FILES, opts('glow')) } } as MessageEvent);
    await expect(pending).resolves.toMatchObject({ total: 4 });
  });

  it('terminates a worker that runs past the timeout', async () => {
    vi.useFakeTimers();
    try {
      const workers: ReturnType<typeof fakeWorker>[] = [];
      const run = createFindRunner(() => {
        const w = fakeWorker();
        workers.push(w);
        return w;
      }, 500);
      const pending = run(FILES, opts('(a+)+$', { regex: true }));
      vi.advanceTimersByTime(501);
      await expect(pending).resolves.toEqual({ files: [], total: 0, truncated: false, timedOut: true });
      expect(workers[0]?.terminated).toBe(true);
      // The next search gets a fresh worker.
      void run(FILES, opts('glow'));
      expect(workers).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('validates requests inside the worker', () => {
    expect(parseFindRequest({ id: 1, files: [{ path: 'a', text: 'b' }], options: opts('x') })).toBeDefined();
    expect(parseFindRequest({ id: 1, files: [{ path: 3, text: 'b' }], options: opts('x') })).toBeUndefined();
    expect(parseFindRequest({ id: 1, files: [], options: { query: 1 } })).toBeUndefined();
    expect(parseFindRequest(null)).toBeUndefined();
  });
});
