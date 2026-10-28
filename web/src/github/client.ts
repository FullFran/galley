import {
  AuthRequiredError,
  GatewayError,
  NotFoundError,
  PermissionError,
  TransientError,
} from '../domain';

export const GITHUB_API = 'https://api.github.com';

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

/** Minimal GitHub REST client. Only ever sends requests to api.github.com. */
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
    if (!res.ok && !options.allow?.includes(res.status)) throw await toError(res);
    let data: T;
    try {
      data = (res.status === 204 ? undefined : await res.json()) as T;
    } catch {
      throw new TransientError(`malformed GitHub response (${res.status})`);
    }
    return { status: res.status, data, headers: res.headers };
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
  return new GatewayError(detail);
}
