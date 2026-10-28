// Each user's auto-compile choice, per repository, in this browser only. The
// project default (`preview.auto_compile`) applies until the user chooses.
// Storage may be missing or blocked (private windows, previews): every access
// is guarded and a failure falls back to the default.

const key = (repo: string) => `galley:auto-compile:${repo}`;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readAutoCompile(repo: string, fallback: boolean, store: Storage | undefined = storage()): boolean {
  try {
    const value = store?.getItem(key(repo));
    return value === 'on' ? true : value === 'off' ? false : fallback;
  } catch {
    return fallback;
  }
}

export function writeAutoCompile(repo: string, auto: boolean, store: Storage | undefined = storage()): void {
  try {
    store?.setItem(key(repo), auto ? 'on' : 'off');
  } catch {
    // Not remembered; the toggle still works for this visit.
  }
}
