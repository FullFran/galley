import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from '../i18n/en';
import type { Config, Driver } from 'driver.js';

const harness = vi.hoisted(() => ({ cleanups: [] as (() => void)[], configs: [] as Config[], seen: false,
  send: vi.fn(), destroy: vi.fn(), drive: vi.fn(), restore: vi.fn(), disconnect: vi.fn() }));
vi.mock('preact/hooks', () => ({
  useRef: (current: unknown) => ({ current }),
  useEffect: (run: () => (() => void) | undefined) => { const cleanup = run(); if (cleanup) harness.cleanups.push(cleanup); },
}));
vi.mock('../i18n', () => ({ useTRef: () => ({ current: en }) }));
vi.mock('../galley/api', async original => ({ ...await original<object>(), createGalleyApi: () => ({ send: harness.send }) }));
const loadDriver = async () => ({ driver: (config?: Config) => {
  harness.configs.push(config ?? {});
  return { drive: harness.drive, destroy: harness.destroy } as unknown as Driver;
} });
import { useTour } from './useTour';

async function settle() { await vi.dynamicImportSettled(); }
function setup(loading = false, demo = false, prepare?: (step: unknown) => Promise<void>) {
  harness.send.mockResolvedValue({ data: { version: 0, status: null } });
  const main = { children: [1], querySelector: () => loading ? {} : null, focus: harness.restore };
  vi.stubGlobal('document', {
    activeElement: undefined, body: {},
    getElementById: () => main,
    querySelector: () => null,
  });
  vi.stubGlobal('HTMLElement', class { isConnected = true; });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }), addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect = harness.disconnect; });
  vi.stubGlobal('sessionStorage', undefined);
  return useTour(1, loadDriver, demo, prepare);
}
afterEach(() => {
  harness.cleanups.splice(0).forEach(cleanup => cleanup());
  harness.configs.length = 0;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
describe('signed-in tour lifetime', () => {
  it('starts once the first useful screen is ready, then restores focus on dismissal', async () => {
    setup(); await settle();
    expect(harness.drive).toHaveBeenCalledTimes(1);
    harness.configs[0]?.onDestroyed?.(undefined, {}, {} as never);
    expect(harness.send).toHaveBeenCalledWith('PUT', '/me/tour', { body: { version: 1, status: 'skipped' } });
    expect(harness.restore).toHaveBeenCalledOnce();
  });
  it('waits during loading and does not start for anonymous users', async () => {
    setup(true); await settle();
    expect(harness.drive).not.toHaveBeenCalled();
    useTour(undefined); await settle();
    expect(harness.send).toHaveBeenCalledTimes(1);
  });
  it('replays both modes after backend completion without auto-starting', async () => {
    const start = setup();
    harness.send.mockResolvedValue({ data: { version: 1, status: 'done' } });
    // The first pending response was already captured; manual replay cancels its auto-start.
    start('screen'); await settle();
    expect(harness.drive).toHaveBeenCalledTimes(1);
    expect(harness.configs[0]?.steps?.[0]?.popover?.title).toBe(en.tour.steps.screen[0]);
    start('full'); await settle();
    expect(harness.drive).toHaveBeenCalledTimes(2);
    expect(harness.configs[1]?.steps?.[0]?.popover?.title).toBe(en.tour.steps.welcome[0]);
  });
  it('cancels pending imports and GET responses on unmount/logout', async () => {
    const start = setup();
    start('full');
    harness.cleanups.splice(0).forEach(cleanup => cleanup());
    await settle();
    expect(harness.drive).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalledWith('PUT', expect.anything(), expect.anything());
  });
  it('keeps only the latest pending replay', async () => {
    const start = setup();
    start('full'); start('screen'); await settle();
    expect(harness.drive).toHaveBeenCalledTimes(1);
    expect(harness.configs[0]?.steps?.[0]?.popover?.title).toBe(en.tour.steps.screen[0]);
  });
});

describe('demo tour', () => {
  const driverOf = (index: number) => ({ isLastStep: () => false, getActiveIndex: () => index, moveTo: vi.fn() }) as unknown as Driver;
  it('walks the navigable guide without calling the galley API', async () => {
    setup(false, true, async () => undefined); await settle();
    expect(harness.drive).toHaveBeenCalledWith(0);
    expect(harness.configs[0]?.steps?.[0]?.popover?.title).toBe(en.tour.steps.demoWelcome[0]);
    harness.configs[0]?.onDestroyed?.(undefined, {}, {} as never);
    expect(harness.send).not.toHaveBeenCalled();
  });
  it('resumes on the next shell when a step navigates to another screen', async () => {
    let arrive!: () => void;
    const prepare = vi.fn(() => new Promise<void>(r => { arrive = r; }));
    setup(false, true, prepare); await settle();
    const driver = driverOf(0);
    harness.configs[0]?.onNextClick?.(undefined, {}, { driver, config: {}, state: {} });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ anchor: 'repos' }));
    // The route change unmounts this shell; the new one picks the tour up at step 2.
    harness.cleanups.splice(0).forEach(cleanup => cleanup());
    arrive();
    useTour(1, loadDriver, true, async () => undefined); await settle();
    expect(harness.drive).toHaveBeenLastCalledWith(1);
    expect(driver.moveTo).not.toHaveBeenCalled();
  });
  it('moves in place when the step stays on the same screen', async () => {
    setup(false, true, async () => undefined); await settle();
    const driver = driverOf(3);
    harness.configs[0]?.onNextClick?.(undefined, {}, { driver, config: {}, state: {} });
    await settle(); await Promise.resolve();
    expect(driver.moveTo).toHaveBeenCalledWith(4);
  });
});
