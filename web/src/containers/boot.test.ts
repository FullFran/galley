import { describe, expect, it } from 'vitest';
import { AuthRequiredError, TransientError } from '../domain';
import { startView } from './boot';

const session = (result: () => Promise<string>) => ({ getAccessToken: result });

describe('startView', () => {
  it('opens the repository picker when a token is available', async () => {
    expect(await startView(session(() => Promise.resolve('t')), '')).toEqual({ name: 'repos' });
  });

  it('shows the signed-out screen when sign in is required', async () => {
    expect(await startView(session(() => Promise.reject(new AuthRequiredError('x'))), '')).toEqual({
      name: 'signedOut',
      loginFailed: false,
    });
  });

  it('reports a failed sign-in from the URL', async () => {
    const view = await startView(session(() => Promise.reject(new AuthRequiredError('x'))), '?login=failed');
    expect(view).toEqual({ name: 'signedOut', loginFailed: true });
  });

  it('explains when the server cannot be reached', async () => {
    const view = await startView(session(() => Promise.reject(new TransientError('x'))), '');
    expect(view).toMatchObject({ name: 'signedOut', loginFailed: false });
    expect(view.name === 'signedOut' && view.notice).toMatch(/could not be reached/i);
  });
});
