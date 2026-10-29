import type { Config, DriveStep, Driver } from 'driver.js';
import type { Messages } from '../i18n';
import type { TourStatus } from './state';
import { DEMO_FULL_NAME } from '../demo/mode';

export type GuideMode = 'full' | 'screen';
type Copy = Messages['tour'];

/** Plain data: no target click, navigation, editor mutation or saving. */
export const GUIDE = [
  { anchor: 'sidebar', key: 'sidebar', screen: false },
  { anchor: 'outline', key: 'outline', screen: true },
  { anchor: 'editor', key: 'editor', screen: true },
  { anchor: 'preview', key: 'preview', screen: true },
  { anchor: 'compile', key: 'compile', screen: true },
  { anchor: 'save', key: 'save', screen: true },
  { anchor: 'proposals', key: 'proposals', screen: true },
  { anchor: 'comments-panel', key: 'comments', screen: true },
  { anchor: 'help', key: 'help', screen: false },
] as const;

type Target = (anchor: string) => Element | undefined;
interface DemoStep { anchor?: string; key: keyof Copy['steps']; route?: string; open?: string }
const DEMO_FILE = `#/r/${DEMO_FULL_NAME}/f/index.qmd`;

/**
 * Demo only: the paper is made up, so this guide may navigate between screens
 * and open panels to reach each target. Saving stays the visitor's choice.
 */
export const DEMO_GUIDE: readonly DemoStep[] = [
  { key: 'demoWelcome' },
  { anchor: 'repos', key: 'repos', route: '#/' },
  { anchor: 'outline', key: 'outline', route: DEMO_FILE },
  { anchor: 'editor', key: 'editor', route: DEMO_FILE },
  { anchor: 'preview', key: 'preview', route: DEMO_FILE },
  { anchor: 'compile', key: 'compile', route: DEMO_FILE },
  { anchor: 'save', key: 'demoSave', route: DEMO_FILE },
  { anchor: 'comments-panel', key: 'demoComments', route: DEMO_FILE, open: 'comments' },
  { anchor: 'proposal-list', key: 'demoProposals', route: `#/r/${DEMO_FULL_NAME}/proposals` },
  { anchor: 'help', key: 'help' },
  { key: 'demoDone' },
];

export function escapeHtml(text: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return text.replace(/[&<>"']/g, c => entities[c] ?? c);
}

export function visibleTarget(anchor: string): Element | undefined {
  const element = document.querySelector(`[data-tour="${anchor}"]`);
  if (!element || element.closest('[hidden], [inert], dialog:not([open])') || !element.getClientRects().length) return;
  const style = getComputedStyle(element);
  if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return;
  return element;
}

const popoverOf = (copy: Copy, key: keyof Copy['steps']) => ({ title: escapeHtml(copy.steps[key][0] ?? ''), description: escapeHtml(copy.steps[key][1] ?? '') });

export function guideSteps(copy: Copy, mode: GuideMode, target: Target = visibleTarget): DriveStep[] {
  const popover = (key: keyof Copy['steps']) => popoverOf(copy, key);
  return [
    { popover: popover(mode === 'full' ? 'welcome' : 'screen') },
    ...GUIDE.filter(step => mode === 'full' || step.screen).flatMap(step => {
      const element = target(step.anchor);
      return element ? [{ element, popover: popover(step.key) }] : [];
    }),
  ];
}

/** Targets resolve when driver.js shows the step: earlier ones may navigate to them. */
export function demoSteps(copy: Copy, target: Target = visibleTarget): DriveStep[] {
  return DEMO_GUIDE.map(({ anchor, key }) => ({
    element: anchor ? (() => target(anchor)) as () => Element : undefined,
    popover: popoverOf(copy, key),
  }));
}

async function waitFor(found: () => unknown, timeout: number): Promise<boolean> {
  for (let waited = 0; waited < timeout; waited += 100) {
    if (found()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return !!found();
}

/** Brings a demo step's target on screen: its route first, then the panel that holds it. */
export async function prepareDemoStep(step: DemoStep | undefined, nav: Pick<Location, 'hash'> = location, target: Target = visibleTarget, timeout = 4000) {
  if (!step) return;
  if (step.route && nav.hash !== step.route) nav.hash = step.route;
  const { anchor, open } = step;
  if (!anchor) return;
  await waitFor(() => target(anchor) ?? (open && target(open)), timeout);
  if (target(anchor) || !open) return;
  (target(open) as HTMLElement | undefined)?.click();
  await waitFor(() => target(anchor), timeout);
}

/**
 * `go(index)` (demo guide) prepares a step before showing it and answers
 * whether this driver should still move; without it driver.js moves itself.
 */
export function tourConfig(copy: Copy, steps: DriveStep[], reducedMotion: boolean, finish: (status: TourStatus) => void, go?: (index: number) => Promise<boolean>): Config {
  let completed = false;
  let moving = false;
  const move = (driver: Driver, index: number) => {
    if (moving || !go) return;
    moving = true;
    void go(index).then(ok => {
      moving = false;
      if (ok) driver.moveTo(index);
    });
  };
  return {
    steps, animate: !reducedMotion, smoothScroll: false,
    disableActiveInteraction: true, allowClose: true, allowKeyboardControl: false,
    popoverClass: 'galley-tour', showProgress: true,
    progressText: escapeHtml(copy.progress(1, steps.length)),
    nextBtnText: escapeHtml(copy.next), prevBtnText: escapeHtml(copy.back), doneBtnText: escapeHtml(copy.done),
    onPopoverRender(popover, { driver }) {
      const index = driver.getActiveIndex() ?? 0;
      popover.progress.textContent = copy.progress(index + 1, steps.length);
      popover.closeButton.setAttribute('aria-label', copy.skip);
      const skip = document.createElement('button');
      skip.type = 'button';
      skip.className = 'tour-skip';
      skip.textContent = copy.skip;
      skip.onclick = () => driver.destroy();
      popover.footerButtons.prepend(skip);
    },
    onNextClick(_element, _step, { driver }) {
      if (driver.isLastStep()) { completed = true; finish('done'); driver.destroy(); }
      else if (go) move(driver, (driver.getActiveIndex() ?? 0) + 1);
      else driver.moveNext();
    },
    ...(go && { onPrevClick: (_element, _step, { driver }) => move(driver, (driver.getActiveIndex() ?? 0) - 1) }),
    onDestroyStarted(_element, _step, { driver }) { if (!completed) finish('skipped'); driver.destroy(); },
  };
}
