import { describe, expect, it } from 'vitest';
import { shouldPoll } from './poll';

describe('shouldPoll', () => {
  it('polls only a running build on a visible page', () => {
    expect(shouldPoll('running', 'visible')).toBe(true);
    expect(shouldPoll('running', 'hidden')).toBe(false);
    for (const state of ['success', 'failure', 'none', undefined] as const) expect(shouldPoll(state, 'visible')).toBe(false);
  });
});
