const KEY = 'galley:demo';

function storage(): Storage | undefined {
  try { return globalThis.sessionStorage; } catch { return undefined; }
}

/**
 * True once `?demo` was on the URL in this tab. App drops the query string at
 * boot, so the flag lives in sessionStorage until the user leaves the demo.
 */
export function demoRequested(search: string): boolean {
  const asked = new URLSearchParams(search).has('demo');
  try {
    if (asked) storage()?.setItem(KEY, '1');
    return asked || storage()?.getItem(KEY) === '1';
  } catch {
    return asked;
  }
}

export function exitDemo(): void {
  try { storage()?.removeItem(KEY); } catch { /* Storage is optional. */ }
}

/** Relative link that opens the demo on the repository list, whatever the app's path. */
export const DEMO_HREF = '?demo#/';
