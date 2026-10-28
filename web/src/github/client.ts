import {
  AuthRequiredError,
  GatewayError,
  NotFoundError,
  PermissionError,
  RejectedError,
  TransientError,
} from '../domain';

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_GRAPHQL = `${GITHUB_API}/graphql`;

/** Supplies GitHub user access tokens; implemented by the auth session client. */
export interface TokenSource {
  getAccessToken(repositoryId?: number): Promise<string>;
  invalidate(): void;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Scopes the token to this repository. */
  repositoryId?: number;
  /** Statuses returned to the caller instead of being mapped to errors. */
  allow?: number[];
}

export interface GitHubResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

/** Minimal GitHub REST and GraphQL client. Only ever sends requests to api.github.com. */
export class GitHubClient {
  private readonly tokens: TokenSource;
  private readonly fetch: typeof globalThis.fetch;

  constructor(tokens: TokenSource, fetch: typeof globalThis.fetch) {
    this.tokens = tokens;
    this.fetch = fetch;
  }

  async request<T>(pathOrUrl: string, options: RequestOptions = {}): Promise<GitHubResponse<T>> {
    const url = toGitHubUrl(pathOrUrl);
    let res = await this.send(url, options);
    if (res.status === 401) {
      // The cached token may have been revoked or rotated: retry once with a new one.
      this.tokens.invalidate();
      res = await this.send(url, options);
      if (res.status === 401) throw new AuthRequiredError('GitHub rejected the access token');
    }
    // fetch follows redirects (renamed repositories answer 301); the answer must still come from GitHub's API.
    if (res.url && new URL(res.url).origin !== GITHUB_API) throw new GatewayError('GitHub redirected off api.github.com');
    if (!res.ok && !options.allow?.includes(res.status)) throw await toError(res);
    let data: T;
    try {
      data = (res.status === 204 ? undefined : await res.json()) as T;
    } catch {
      throw new TransientError(`malformed GitHub response (${res.status})`);
    }
    return { status: res.status, data, headers: res.headers };
  }

  /**
   * Runs a GraphQL query or mutation at api.github.com/graphql (the same
   * origin as REST, so the same host check holds). GraphQL reports most
   * failures as `errors` in a 200 response; those are mapped like REST errors.
   */
  async graphql<T>(query: string, variables: Record<string, unknown>, repositoryId?: number): Promise<T> {
    const res = await this.request<{ data?: T | null; errors?: { type?: unknown; message?: unknown }[] }>(GITHUB_GRAPHQL, {
      method: 'POST',
      body: { query, variables },
      repositoryId,
    });
    const errors = Array.isArray(res.data?.errors) ? res.data.errors : [];
    if (errors.length > 0) {
      const type = typeof errors[0]?.type === 'string' ? errors[0].type : '';
      const message = typeof errors[0]?.message === 'string' ? errors[0].message : '';
      const detail = `GitHub GraphQL ${type || 'error'}${message ? `: ${message}` : ''}`;
      if (type === 'NOT_FOUND') throw new NotFoundError(detail);
      if (type === 'FORBIDDEN' || type === 'INSUFFICIENT_SCOPES') throw new PermissionError(detail);
      if (type === 'RATE_LIMITED') throw new TransientError(detail);
      throw new GatewayError(detail);
    }
    if (res.data?.data === undefined || res.data.data === null) throw new TransientError('empty GitHub GraphQL response');
    return res.data.data;
  }

  /** Fetches every page of a list endpoint, following the Link `next` relation. */
  async paginate<T, I>(path: string, items: (page: T) => I[], repositoryId?: number): Promise<I[]> {
    const all: I[] = [];
    let next: string | undefined = path;
    while (next) {
      const res: GitHubResponse<T> = await this.request<T>(next, { repositoryId });
      all.push(...items(res.data));
      next = nextLink(res.headers.get('Link'));
    }
    return all;
  }

  /**
   * Downloads an Actions artifact zip. The only request allowed to leave
   * api.github.com: GitHub answers 302/303 with a short-lived signed URL on
   * Azure blob storage, which fetch follows (dropping Authorization on the
   * cross-origin hop). Any other path is refused before sending, and a
   * redirect anywhere but blob storage is refused before reading. 410 means
   * the artifact expired.
   */
  async downloadArtifact(path: string, repositoryId?: number): Promise<{ kind: 'ok'; bytes: Uint8Array } | { kind: 'expired' }> {
    const url = new URL(toGitHubUrl(path));
    if (!isArtifactZipPath(url)) throw new GatewayError(`not an artifact download: ${url.pathname}`);
    const get = async () => {
      const token = await this.tokens.getAccessToken(repositoryId);
      try {
        // Only CORS-safelisted headers besides Authorization, so the redirected
        // request (without Authorization) needs no preflight at the blob host.
        return await this.fetch(url.href, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, redirect: 'follow' });
      } catch {
        throw new TransientError('artifact download failed');
      }
    };
    let res = await get();
    if (res.status === 401) {
      this.tokens.invalidate();
      res = await get();
      if (res.status === 401) throw new AuthRequiredError('GitHub rejected the access token');
    }
    if (res.url) {
      const landed = new URL(res.url);
      if (landed.origin !== GITHUB_API && !isArtifactHost(landed)) throw new GatewayError(`unexpected artifact host ${landed.host}`);
    }
    if (res.status === 410) return { kind: 'expired' };
    if (!res.ok) throw await toError(res);
    try {
      return { kind: 'ok', bytes: new Uint8Array(await res.arrayBuffer()) };
    } catch {
      throw new TransientError('artifact download interrupted');
    }
  }

  private async send(url: string, options: RequestOptions): Promise<Response> {
    const token = await this.tokens.getAccessToken(options.repositoryId);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await this.fetch(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch {
      throw new TransientError('GitHub unreachable');
    }
  }
}

function toGitHubUrl(pathOrUrl: string): string {
  const url = new URL(pathOrUrl, GITHUB_API);
  if (url.origin !== GITHUB_API) throw new GatewayError(`unexpected host ${url.host}`);
  return url.href;
}

/** `/repos/{owner}/{repo}/actions/artifacts/{id}/zip` on api.github.com, nothing else. */
export function isArtifactZipPath(url: URL): boolean {
  return url.origin === GITHUB_API && /^\/repos\/[^/]+\/[^/]+\/actions\/artifacts\/\d+\/zip$/.test(url.pathname);
}

/**
 * Where GitHub stores artifacts (for example productionresultssa12.blob.core.windows.net).
 * Must match the CSP `connect-src` entry in vite.config.ts.
 */
export function isArtifactHost(url: URL): boolean {
  return url.protocol === 'https:' && /^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(url.hostname) && url.port === '';
}

function nextLink(header: string | null): string | undefined {
  for (const part of header?.split(',') ?? []) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1];
  }
  return undefined;
}

async function toError(res: Response): Promise<GatewayError> {
  const message = await res
    .json()
    .then((body: { message?: unknown }) => (typeof body.message === 'string' ? body.message : ''))
    .catch(() => '');
  const detail = `GitHub ${res.status}${message ? `: ${message}` : ''}`;
  const rateLimited =
    res.status === 429 ||
    (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')));
  if (rateLimited || res.status >= 500) return new TransientError(detail);
  if (res.status === 404) return new NotFoundError(detail);
  if (res.status === 403) return new PermissionError(detail);
  if (res.status === 422) return new RejectedError(detail);
  return new GatewayError(detail);
}
