import { useT } from '../../i18n';
import { AUTHOR_URL, SOURCE_URL } from '../../shell/credits';

/** Author credit and source link (landing footer, sidebar footer, About). */
export function Credit() {
  const m = useT().credit;
  return (
    <p class="credit">
      {m.builtBy}{' '}
      <a href={AUTHOR_URL} target="_blank" rel="noopener noreferrer">
        {m.author}
      </a>
      <span aria-hidden="true"> · </span>
      <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
        {m.source}
      </a>
    </p>
  );
}
