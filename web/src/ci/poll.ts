import type { CiState } from './status';

/** How often a running build is looked at again. */
export const POLL_MS = 20_000;

/** Ask GitHub again only while the build runs and the page is visible. */
export function shouldPoll(state: CiState | undefined, visibility: DocumentVisibilityState): boolean {
  return state === 'running' && visibility === 'visible';
}
