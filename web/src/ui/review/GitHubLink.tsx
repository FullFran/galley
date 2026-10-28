import { useT } from '../../i18n';
import { githubUrl } from '../../review/status';

/** A link to GitHub, rendered only for https://github.com URLs. */
export function GitHubLink({ href, label }: { href?: string; label?: string }) {
  const t = useT();
  const url = githubUrl(href);
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {label ?? t.github.view}
    </a>
  );
}
