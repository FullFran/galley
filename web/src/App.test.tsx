import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import { App } from './App';
import type { Session } from './auth/session';
import type { RepoGateway, ReviewGateway } from './domain';

describe('App', () => {
  it('shows a loading state until the session is checked', () => {
    const session = {} as Session;
    const gateway = {} as RepoGateway;
    const reviews = {} as ReviewGateway;
    expect(render(<App session={session} gateway={gateway} reviews={reviews} />)).toContain('Loading');
  });
});
