import { githubUrl } from '../../review/status';

/** A link to GitHub, rendered only for https://github.com URLs. */
export function GitHubLink({ href, label = 'View on GitHub' }: { href?: string; label?: string }) {
  const url = githubUrl(href);
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
