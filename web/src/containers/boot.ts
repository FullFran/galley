import { AuthRequiredError } from '../domain';
import type { Session } from '../auth/session';
import { describeError } from '../workspace/model';

export type StartView =
  | { name: 'repos' }
  | { name: 'signedOut'; loginFailed: boolean; notice?: string };

/** Decides the first screen: a usable session opens the repository picker. */
export async function startView(session: Pick<Session, 'getAccessToken'>, search: string): Promise<StartView> {
  const loginFailed = new URLSearchParams(search).get('login') === 'failed';
  try {
    await session.getAccessToken();
    return { name: 'repos' };
  } catch (err) {
    if (err instanceof AuthRequiredError) return { name: 'signedOut', loginFailed };
    return { name: 'signedOut', loginFailed, notice: describeError(err) };
  }
}
