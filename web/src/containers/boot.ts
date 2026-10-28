import { AuthRequiredError } from '../domain';
import type { Session } from '../auth/session';
import { describeError } from '../workspace/model';

export type StartView =
  | { name: 'repos' }
  | { name: 'signedOut'; loginFailed: boolean; notice?: string; httpsUrl?: string };

/** The parts of `window.location` that decide whether galley can sign in. */
export type PageOrigin = Pick<Location, 'protocol' | 'hostname' | 'pathname'>;

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

/**
 * The https address to use instead, when the page was opened over plain http on
 * a public host. The session cookie is `Secure`, so sign in cannot work there.
 * Loopback http stays allowed for local development.
 */
export function httpsUrlFor(origin: PageOrigin): string | undefined {
  if (origin.protocol !== 'http:' || isLoopback(origin.hostname)) return undefined;
  return `https://${origin.hostname}${origin.pathname}`;
}

/** Decides the first screen: a usable session opens the repository picker. */
export async function startView(
  session: Pick<Session, 'getAccessToken'>,
  search: string,
  origin?: PageOrigin,
): Promise<StartView> {
  const loginFailed = new URLSearchParams(search).get('login') === 'failed';
  const httpsUrl = origin && httpsUrlFor(origin);
  if (httpsUrl) return { name: 'signedOut', loginFailed, httpsUrl };
  try {
    await session.getAccessToken();
    return { name: 'repos' };
  } catch (err) {
    if (err instanceof AuthRequiredError) return { name: 'signedOut', loginFailed };
    return { name: 'signedOut', loginFailed, notice: describeError(err) };
  }
}
