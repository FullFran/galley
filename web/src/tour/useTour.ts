import { useEffect, useRef } from 'preact/hooks';
import type { Driver } from 'driver.js';
import { createGalleyApi } from '../galley/api';
import { useTRef } from '../i18n';
import { inDemo } from '../demo/mode';
import { DEMO_GUIDE, demoSteps, guideSteps, prepareDemoStep, tourConfig, type GuideMode } from './guide';
import { createTourState, sessionMirror } from './state';
import 'driver.js/dist/driver.css';

const lazyDriver: () => Promise<Pick<typeof import('driver.js'), 'driver'>> = () => import('driver.js');
/** The demo has no account to remember the tour in. */
const offline = { send: () => Promise.resolve({ data: undefined }) };
/**
 * Demo step that a navigating step left for the next shell: each screen
 * mounts its own shell, so the tour hops from one to the next.
 */
let handoff: number | undefined;

/** The shell owns lifetime: navigation/logout cancel imports, observers and overlays. */
export function useTour(userId?: number, loadDriver = lazyDriver, demo = inDemo(), prepare = prepareDemoStep): (mode: GuideMode) => void {
  const copy = useTRef();
  const launch = useRef<(mode: GuideMode) => void>(() => undefined);
  useEffect(() => {
    if (userId === undefined) return;
    const state = createTourState(userId, demo ? offline : createGalleyApi('tour'), sessionMirror());
    let live = true;
    let request = 0;
    let driver: Driver | undefined;
    let observer: MutationObserver | undefined;
    let finishCurrent: (() => void) | undefined;
    let keyHandler: ((e: KeyboardEvent) => void) | undefined;
    const start = async (mode: GuideMode, at = 0) => {
      const generation = ++request;
      observer?.disconnect();
      finishCurrent?.();
      driver?.destroy();
      driver = undefined;
      try {
        const module = await loadDriver();
        if (!live || request !== generation) return;
        const guided = demo && mode === 'full';
        if (guided && at) {
          await prepare(DEMO_GUIDE[at]);
          if (!live || request !== generation) return;
        }
        const previous = document.activeElement;
        let finished = false;
        const finish = (status: 'done' | 'skipped') => {
          if (finished) return;
          finished = true;
          state.finish(status);
        };
        finishCurrent = () => finish('skipped');
        const go = async (index: number) => {
          handoff = index;
          await prepare(DEMO_GUIDE[index]);
          // A route change may have replaced this shell; the next one resumes.
          if (!live || request !== generation) return false;
          handoff = undefined;
          return true;
        };
        const config = tourConfig(copy.current.tour, guided ? demoSteps(copy.current.tour) : guideSteps(copy.current.tour, mode),
          window.matchMedia('(prefers-reduced-motion: reduce)').matches, finish, guided ? go : undefined);
        config.onDestroyed = () => {
          finish('skipped');
          if (keyHandler) window.removeEventListener('keydown', keyHandler, true);
          if (previous instanceof HTMLElement && previous.isConnected && !previous.closest('[hidden], [inert]')) previous.focus();
          else document.getElementById('main')?.focus();
        };
        driver = module.driver(config);
        keyHandler = (e: KeyboardEvent) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopImmediatePropagation();
          driver?.destroy();
        };
        window.addEventListener('keydown', keyHandler, true);
        state.claim();
        driver.drive(at);
      } catch { /* Loading failure must not break the editor or mark the tour seen. */ }
    };
    launch.current = mode => { void start(mode); };
    if (demo && handoff !== undefined) {
      const at = handoff;
      handoff = undefined;
      void start('full', at);
    }
    void state.seen().then(seen => {
      if (!live || seen || request !== 0) return;
      const ready = () => {
        const main = document.getElementById('main');
        if (!main?.children.length || main.querySelector('.skeleton') || document.querySelector('dialog[open]')) return;
        void start('full');
      };
      observer = new MutationObserver(ready);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'inert', 'open'] });
      ready();
    });
    return () => {
      live = false;
      request++;
      launch.current = () => undefined;
      observer?.disconnect();
      finishCurrent?.();
      driver?.destroy();
      if (keyHandler) window.removeEventListener('keydown', keyHandler, true);
      state.dispose();
    };
  }, [userId, copy, loadDriver]);
  return mode => launch.current(mode);
}
