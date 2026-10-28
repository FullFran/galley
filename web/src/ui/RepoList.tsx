import { useState } from 'preact/hooks';
import type { Repository } from '../domain';
import { useT } from '../i18n';
import { Icon } from './shell/icons';

export interface RepoListProps {
  repos: Repository[];
  onOpen: (repo: Repository) => void;
  onReload?: () => void;
}

const SEARCH_FROM = 6;
const day = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { dateStyle: 'medium' });
};

export function RepoList({ repos, onOpen, onReload }: RepoListProps) {
  const t = useT();
  const m = t.repos;
  const [query, setQuery] = useState('');
  if (repos.length === 0) {
    return (
      <div class="empty">
        <Icon name="library" class="empty-icon" />
        <h2>{m.emptyTitle}</h2>
        <p>{m.emptyBody}</p>
        {onReload && (
          <button type="button" class="primary" onClick={onReload}>
            {m.reload}
          </button>
        )}
      </div>
    );
  }
  const q = query.trim().toLowerCase();
  const shown = q ? repos.filter((r) => r.fullName.toLowerCase().includes(q)) : repos;
  return (
    <>
      {repos.length >= SEARCH_FROM && (
        <label class="search">
          <span class="visually-hidden">{m.search}</span>
          <input type="search" value={query} placeholder={m.searchPlaceholder} onInput={(e) => setQuery(e.currentTarget.value)} />
        </label>
      )}
      {shown.length === 0 ? (
        <div class="empty">
          <p>{m.noMatch(query.trim())}</p>
          <button type="button" onClick={() => setQuery('')}>
            {m.clearSearch}
          </button>
        </div>
      ) : (
        <ul class="row-list">
          {shown.map((repo) => (
            <li key={repo.id} class="row">
              <button type="button" class="row-main" onClick={() => onOpen(repo)}>
                <Icon name="library" />
                <span class="row-title">{repo.fullName}</span>
              </button>
              <span class="chip">{repo.private ? m.private : m.public}</span>
              {repo.updatedAt && day(repo.updatedAt) && <span class="muted row-meta">{m.updated(day(repo.updatedAt))}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
