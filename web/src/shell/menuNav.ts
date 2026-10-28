// Arrow-key movement in a menu (WAI-ARIA menu pattern): Down/Up wrap, Home
// and End jump, disabled items are skipped.

export function nextMenuIndex(key: string, current: number, enabled: readonly boolean[]): number | undefined {
  const n = enabled.length;
  if (!enabled.some(Boolean)) return undefined;
  const scan = (start: number, step: 1 | -1) => {
    for (let i = 0; i < n; i++) {
      const idx = (((start + step * i) % n) + n) % n;
      if (enabled[idx]) return idx;
    }
    return undefined;
  };
  switch (key) {
    case 'ArrowDown':
      return scan(current + 1, 1);
    case 'ArrowUp':
      return scan(current < 0 ? n - 1 : current - 1, -1);
    case 'Home':
      return scan(0, 1);
    case 'End':
      return scan(n - 1, -1);
    default:
      return undefined;
  }
}
