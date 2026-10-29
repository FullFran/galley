import { useEffect, useState } from 'preact/hooks';

/**
 * Whether the element is at least `rem` root-em wide, kept current as it
 * resizes (browser zoom, the sidebar, the window). Before the first
 * measurement, and without ResizeObserver, it assumes it fits.
 */
export function useFits(rem: number): [boolean, (el: HTMLElement | null) => void] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [fits, setFits] = useState(true);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setFits(el.getBoundingClientRect().width >= rem * root);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, rem]);
  return [fits, setEl];
}
