import { describe, expect, it } from 'vitest';
import { AuthRequiredError, TransientError } from '../domain';
import { httpsUrlFor, startView } from './boot';

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

const origin = (protocol: string, hostname: string, pathname = '/') => ({ protocol, hostname, pathname });

describe('httpsUrlFor', () => {
  it('asks for https on a public http origin', () => {
    expect(httpsUrlFor(origin('http:', 'galley.fullfran.com'))).toBe('https://galley.fullfran.com/');
  });

  it('keeps the path and drops the http port', () => {
    expect(httpsUrlFor(origin('http:', 'example.org', '/galley/'))).toBe('https://example.org/galley/');
  });

  it('allows http on loopback for local development', () => {
    for (const host of ['localhost', '127.0.0.1', '127.0.0.2', '[::1]', 'app.localhost']) {
      expect(httpsUrlFor(origin('http:', host))).toBeUndefined();
    }
  });

  it('accepts https origins', () => {
    expect(httpsUrlFor(origin('https:', 'galley.fullfran.com'))).toBeUndefined();
  });
});

describe('startView on an http origin', () => {
  it('asks for https without calling the token endpoint', async () => {
    let called = false;
    const tokens = session(() => {
      called = true;
      return Promise.resolve('t');
    });
    const view = await startView(tokens, '', origin('http:', 'galley.fullfran.com'));
    expect(view).toEqual({ name: 'signedOut', loginFailed: false, httpsUrl: 'https://galley.fullfran.com/' });
    expect(called).toBe(false);
  });

  it('signs in normally on loopback http', async () => {
    const view = await startView(session(() => Promise.resolve('t')), '', origin('http:', '127.0.0.1'));
    expect(view).toEqual({ name: 'repos' });
  });
});
