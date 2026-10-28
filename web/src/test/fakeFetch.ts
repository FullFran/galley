export interface RecordedRequest {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
  credentials: RequestCredentials | undefined;
}

export type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * A fetch replacement that records every request and answers from `routes`.
 * Each route returns a Response for requests it handles, or undefined.
 */
export function fakeFetch(routes: Route[]) {
  const requests: RecordedRequest[] = [];
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const raw = typeof init.body === 'string' ? init.body : undefined;
    const req: RecordedRequest = {
      method: (init.method ?? 'GET').toUpperCase(),
      url: String(input),
      headers: new Headers(init.headers),
      body: raw === undefined ? undefined : (JSON.parse(raw) as unknown),
      credentials: init.credentials,
    };
    requests.push(req);
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    throw new Error(`unexpected request ${req.method} ${req.url}`);
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

/** Route helper matching an exact method and URL (query included). */
export function on(
  method: string,
  url: string,
  respond: (req: RecordedRequest) => Response | Promise<Response>,
): Route {
  return (req) => (req.method === method && req.url === url ? respond(req) : undefined);
}
