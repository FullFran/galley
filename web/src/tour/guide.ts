import type { Config, DriveStep } from 'driver.js';
import type { Messages } from '../i18n';
import type { TourStatus } from './state';

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

export function guideSteps(copy: Copy, mode: GuideMode, target = visibleTarget): DriveStep[] {
  const popover = (key: keyof Copy['steps']) => ({ title: escapeHtml(copy.steps[key][0] ?? ''), description: escapeHtml(copy.steps[key][1] ?? '') });
  return [
    { popover: popover(mode === 'full' ? 'welcome' : 'screen') },
    ...GUIDE.filter(step => mode === 'full' || step.screen).flatMap(step => {
      const element = target(step.anchor);
      return element ? [{ element, popover: popover(step.key) }] : [];
    }),
  ];
}

export function tourConfig(copy: Copy, steps: DriveStep[], reducedMotion: boolean, finish: (status: TourStatus) => void): Config {
  let completed = false;
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
      else driver.moveNext();
    },
    onDestroyStarted(_element, _step, { driver }) { if (!completed) finish('skipped'); driver.destroy(); },
  };
}
