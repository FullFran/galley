import { isRecord, type GalleyApi, type SendOptions } from '../galley/api';

export type TourStatus = 'done' | 'skipped';
type Api = { send(method: string, path: string, options?: SendOptions): Promise<{ data: unknown }> };
type Mirror = Pick<Storage, 'getItem' | 'setItem'>;

export function sessionMirror(): Storage | undefined {
  try { return globalThis.sessionStorage; } catch { return undefined; }
}

/** A generation belongs to one signed-in shell; stale requests never update it. */
export function createTourState(userId: number, api: Api | GalleyApi, mirror?: Mirror) {
  const key = `galley:tour:1:${userId}`;
  let active = true;
  let local: TourStatus | undefined;
  try {
    const saved = mirror?.getItem(key);
    if (saved === 'done' || saved === 'skipped') local = saved;
  } catch { /* Storage is optional. */ }
  const remember = (status: TourStatus) => {
    local = status;
    try { mirror?.setItem(key, status); } catch { /* Private browsing / quota. */ }
  };
  return {
    async seen() {
      if (local) return true;
      // An unavailable API must not hold onboarding indefinitely.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          api.send('GET', '/me/tour'),
          new Promise<undefined>(resolve => { timer = setTimeout(resolve, 1500); }),
        ]);
        if (!active || local) return true;
        const data = result?.data;
        if (isRecord(data) && data.version === 1 && (data.status === 'done' || data.status === 'skipped')) remember(data.status);
      } catch { /* Best effort, including old API deployments. */ }
      finally { clearTimeout(timer); }
      return !active || !!local;
    },
    claim() { if (active) remember('skipped'); },
    finish(status: TourStatus) {
      if (!active) return;
      remember(status);
      void api.send('PUT', '/me/tour', { body: { version: 1, status } }).catch(() => undefined);
    },
    dispose() { active = false; },
  };
}
