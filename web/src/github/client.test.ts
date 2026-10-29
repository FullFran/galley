import { describe, expect, it, vi } from 'vitest';
import { GatewayError, NotFoundError } from '../domain';
import { fakeFetch, json, type Route } from '../test/fakeFetch';
import { GitHubClient, isArtifactZipPath, isArtifactHost } from './client';

const GH = 'https://api.github.com';
const ZIP = `${GH}/repos/octo/paper/actions/artifacts/42/zip`;
const BLOB = 'https://productionresultssa12.blob.core.windows.net/actions-results/x/a.zip?sig=s';

/** A response as fetch returns it after following redirects to `url`. */
function landedAt(url: string, res: Response): Response {
  Object.defineProperty(res, 'url', { value: url });
  Object.defineProperty(res, 'redirected', { value: url !== '' });
  return res;
}

function client(routes: Route[]) {
  const tokens = { getAccessToken: vi.fn(async () => 'tok'), invalidate: vi.fn() };
  const fake = fakeFetch(routes);
  return { gh: new GitHubClient(tokens, fake.fetch), ...fake };
}

describe('GitHub responses are never served from the browser cache', () => {
  // GitHub answers with Cache-Control: private, max-age=60. A cached branch
  // head turned back-to-back saves into false "someone else changed it" conflicts.
  it('revalidates every request and artifact download', async () => {
    const { gh, requests } = client([
      (req) => (req.url === ZIP ? landedAt(BLOB, new Response(new Uint8Array([1]), { status: 200 })) : undefined),
      (req) => (req.url.startsWith(GH) ? new Response('{}', { status: 200 }) : undefined),
    ]);
    await gh.request('/repos/octo/paper/git/ref/heads/main');
    await gh.request('/repos/octo/paper/pulls', { method: 'POST', body: {} });
    await gh.downloadArtifact('/repos/octo/paper/actions/artifacts/42/zip');
    expect(requests.map((r) => r.cache)).toEqual(['no-cache', 'no-cache', 'no-cache']);
  });
});

describe('artifact zip redirect allowance', () => {
  it('recognises only the artifact zip endpoint', () => {
    expect(isArtifactZipPath(new URL(ZIP))).toBe(true);
    expect(isArtifactZipPath(new URL(`${GH}/repos/octo/paper/actions/artifacts/42`))).toBe(false);
    expect(isArtifactZipPath(new URL(`${GH}/repos/octo/paper/actions/artifacts/42/zip/more`))).toBe(false);
    expect(isArtifactZipPath(new URL(`${GH}/repos/octo/paper/zipball/main`))).toBe(false);
    expect(isArtifactZipPath(new URL(`${GH}/repos/octo/paper/actions/artifacts/x/zip`))).toBe(false);
  });

  it('allows only Azure blob storage hosts over https', () => {
    expect(isArtifactHost(new URL(BLOB))).toBe(true);
    expect(isArtifactHost(new URL('http://productionresultssa12.blob.core.windows.net/a'))).toBe(false);
    expect(isArtifactHost(new URL('https://blob.core.windows.net.evil.example/a'))).toBe(false);
    expect(isArtifactHost(new URL('https://evil.example/a'))).toBe(false);
  });

  it('downloads the zip after the redirect to blob storage', async () => {
    const { gh, requests } = client([
      (req) => (req.url === ZIP ? landedAt(BLOB, new Response(new Uint8Array([80, 75, 3, 4]), { status: 200 })) : undefined),
    ]);
    const res = await gh.downloadArtifact('/repos/octo/paper/actions/artifacts/42/zip');
    expect(res).toEqual({ kind: 'ok', bytes: new Uint8Array([80, 75, 3, 4]) });
    expect(requests[0]?.headers.get('Authorization')).toBe('Bearer tok');
    // No custom header, so the redirected request needs no CORS preflight at the blob host.
    expect(requests[0]?.headers.has('X-GitHub-Api-Version')).toBe(false);
  });

  it('refuses a zip redirect that lands outside blob storage', async () => {
    const { gh } = client([(req) => (req.url === ZIP ? landedAt('https://evil.example/a.zip', new Response('x')) : undefined)]);
    await expect(gh.downloadArtifact('/repos/octo/paper/actions/artifacts/42/zip')).rejects.toThrow(GatewayError);
  });

  it('refuses other endpoints for downloads', async () => {
    const { gh, requests } = client([]);
    await expect(gh.downloadArtifact('/repos/octo/paper/zipball/main')).rejects.toThrow(GatewayError);
    await expect(gh.downloadArtifact('https://evil.example/repos/o/r/actions/artifacts/1/zip')).rejects.toThrow(GatewayError);
    expect(requests).toHaveLength(0);
  });

  it('reports an expired artifact (410)', async () => {
    const { gh } = client([(req) => (req.url === ZIP ? json({ message: 'Artifact has expired' }, 410) : undefined)]);
    expect(await gh.downloadArtifact('/repos/octo/paper/actions/artifacts/42/zip')).toEqual({ kind: 'expired' });
  });

  it('maps other failures to errors', async () => {
    const { gh } = client([(req) => (req.url === ZIP ? json({ message: 'Not Found' }, 404) : undefined)]);
    await expect(gh.downloadArtifact('/repos/octo/paper/actions/artifacts/42/zip')).rejects.toThrow(NotFoundError);
  });

  it('refuses a JSON response that was redirected off api.github.com', async () => {
    const { gh } = client([(req) => (req.url === `${GH}/user` ? landedAt(BLOB, json({ login: 'x' })) : undefined)]);
    await expect(gh.request('/user')).rejects.toThrow(GatewayError);
  });

  it('accepts a JSON redirect that stays on api.github.com', async () => {
    const { gh } = client([(req) => (req.url === `${GH}/repos/old/name` ? landedAt(`${GH}/repositories/1`, json({ id: 1 })) : undefined)]);
    expect((await gh.request<{ id: number }>('/repos/old/name')).data).toEqual({ id: 1 });
  });
});
