import type { Repository } from '../domain';

export interface RepoListProps {
  repos: Repository[];
  onOpen: (repo: Repository) => void;
}

export function RepoList({ repos, onOpen }: RepoListProps) {
  if (repos.length === 0) {
    return (
      <div class="card">
        <h2>No repositories yet</h2>
        <p>
          galley can only open repositories where the galley GitHub App is installed. Ask the owner of the
          repository to install it and give you access, then reload this page.
        </p>
      </div>
    );
  }
  return (
    <ul class="repo-list">
      {repos.map((repo) => (
        <li key={repo.id}>
          <button type="button" onClick={() => onOpen(repo)}>
            {repo.fullName}
            {repo.private && <span class="muted"> (private)</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
