import { describe, expect, it } from 'vitest';
import { createTextCache } from './textCache';

function reader() {
  const reads: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const read = async (path: string, ref: string) => {
    reads.push(`${path}@${ref}`);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    if (path === 'missing.qmd') throw new Error('404');
    return `${path} at ${ref}`;
  };
  return { read, reads, max: () => maxInFlight };
}

describe('index text cache', () => {
  it('reads each file once per blob, so a new commit re-reads only changed files', async () => {
    const r = reader();
    const cache = createTextCache(r.read);
    const blobs = { 'a.qmd': { sha: 'a1' }, 'b.qmd': { sha: 'b1' }, 'c.bib': { sha: 'c1' } };
    await cache.texts(['a.qmd', 'b.qmd', 'c.bib'], blobs, 'h1');
    expect(r.reads).toEqual(['a.qmd@h1', 'b.qmd@h1', 'c.bib@h1']);

    // A save changed b.qmd: new head, new blob for b only.
    const next = await cache.texts(['a.qmd', 'b.qmd', 'c.bib'], { ...blobs, 'b.qmd': { sha: 'b2' } }, 'h2');
    expect(r.reads).toEqual(['a.qmd@h1', 'b.qmd@h1', 'c.bib@h1', 'b.qmd@h2']);
    expect(next).toEqual([
      { path: 'a.qmd', text: 'a.qmd at h1' },
      { path: 'b.qmd', text: 'b.qmd at h2' },
      { path: 'c.bib', text: 'c.bib at h1' },
    ]);
  });

  it('falls back to the commit when the blob SHA is unknown, and skips unreadable files', async () => {
    const r = reader();
    const cache = createTextCache(r.read);
    const out = await cache.texts(['x.qmd', 'missing.qmd'], {}, 'h1');
    expect(out).toEqual([{ path: 'x.qmd', text: 'x.qmd at h1' }, { path: 'missing.qmd', text: undefined }]);
    await cache.texts(['x.qmd'], {}, 'h1');
    expect(r.reads).toEqual(['x.qmd@h1', 'missing.qmd@h1']);
  });

  it('keeps at most six reads in flight', async () => {
    const r = reader();
    const cache = createTextCache(r.read);
    const paths = Array.from({ length: 20 }, (_, i) => `f${i}.qmd`);
    await cache.texts(paths, {}, 'h1');
    expect(r.reads).toHaveLength(20);
    expect(r.max()).toBeLessThanOrEqual(6);
  });
});
