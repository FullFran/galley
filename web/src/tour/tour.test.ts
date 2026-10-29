import { describe, expect, it, vi } from 'vitest';
import { en } from '../i18n/en';
import { es } from '../i18n/es';
import { createTourState } from './state';
import { escapeHtml, guideSteps, tourConfig, visibleTarget } from './guide';
import type { Config, Driver } from 'driver.js';

function memory() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
}
const api = () => ({ send: vi.fn().mockResolvedValue({ data: { version: 0, status: null } }) });

describe('per-user tour state', () => {
  it('mirrors immediately, isolates users and survives API failure', async () => {
    const storage = memory();
    const remote = api();
    remote.send.mockRejectedValue(new Error('offline'));
    const a = createTourState(1, remote, storage);
    expect(await a.seen()).toBe(false);
    a.finish('skipped');
    expect(await createTourState(1, remote, storage).seen()).toBe(true);
    expect(await createTourState(2, remote, storage).seen()).toBe(false);
    expect(remote.send).toHaveBeenCalledWith('PUT', '/me/tour', { body: { version: 1, status: 'skipped' } });
  });
  it('does not let a late GET overwrite a local completion or write after disposal', async () => {
    const storage = memory();
    const remote = api();
    let resolve!: (v: unknown) => void;
    remote.send.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const state = createTourState(1, remote, storage);
    const pending = state.seen();
    state.finish('done');
    resolve({ data: { version: 1, status: 'skipped' } });
    expect(await pending).toBe(true);
    expect([...['galley:tour:1:1'].map(k => storage.getItem(k))]).toEqual(['done']);
    state.dispose();
    state.finish('skipped');
    expect(storage.getItem('galley:tour:1:1')).toBe('done');
  });
  it('uses backend seen state but ignores other versions; blocked storage is harmless', async () => {
    const remote = api();
    remote.send.mockResolvedValue({ data: { version: 1, status: 'done' } });
    expect(await createTourState(1, remote).seen()).toBe(true);
    remote.send.mockResolvedValue({ data: { version: 2, status: 'done' } });
    expect(await createTourState(1, remote).seen()).toBe(false);
  });
});

describe('plain-data guides', () => {
  it('keeps a centred welcome and skips missing/hidden anchors for both guides', () => {
    const element = {} as Element;
    for (const mode of ['full', 'screen'] as const) {
      const steps = guideSteps(en.tour, mode, name => name === 'editor' ? element : undefined);
      expect(steps[0]?.element).toBeUndefined();
      expect(steps).toHaveLength(2);
      expect(steps[1]?.element).toBe(element);
    }
  });
  it('rejects hidden, inert and zero-size targets', () => {
    const element = { closest: vi.fn(() => null as unknown), getClientRects: vi.fn(() => [1]) };
    vi.stubGlobal('document', { querySelector: () => element });
    vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible', display: 'block', opacity: '1' }));
    expect(visibleTarget('editor')).toBe(element);
    element.closest.mockReturnValue({});
    expect(visibleTarget('editor')).toBeUndefined();
    element.closest.mockReturnValue(null);
    element.getClientRects.mockReturnValue([]);
    expect(visibleTarget('editor')).toBeUndefined();
    vi.unstubAllGlobals();
  });
  it('escapes every HTML metacharacter and avoids deferred feature promises', () => {
    expect(escapeHtml('<img src="x" onerror=\'x\'>&')).toBe('&lt;img src=&quot;x&quot; onerror=&#39;x&#39;&gt;&amp;');
    for (const t of [en, es]) {
      expect(JSON.stringify(t.tour)).not.toMatch(/MCP|notification|gallery|galería|notificaci/i);
      expect(t.tour.progress(2, 3)).toContain('2');
    }
  });
  it('counts filtered steps, respects reduced motion and completes only on explicit last Next', () => {
    for (const copy of [en.tour, es.tour]) {
      const finish = vi.fn();
      const config: Config = tourConfig(copy, guideSteps(copy, 'full', () => undefined), true, finish);
      expect(config.animate).toBe(false);
      expect(config.smoothScroll).toBe(false);
      expect(config.progressText).toBe(copy.progress(1, 1));
      const driver = { isLastStep: () => true, destroy: vi.fn(), moveNext: vi.fn() } as unknown as Driver;
      config.onDestroyStarted?.(undefined, {}, { driver, config, state: {} });
      expect(finish).toHaveBeenLastCalledWith('skipped');
      config.onNextClick?.(undefined, {}, { driver, config, state: {} });
      expect(finish).toHaveBeenLastCalledWith('done');
      config.onDestroyStarted?.(undefined, {}, { driver, config, state: {} });
      expect(finish).toHaveBeenLastCalledWith('done');
      expect(finish).toHaveBeenCalledTimes(2);
      expect(driver.destroy).toHaveBeenCalledTimes(3);
    }
  });
});
