import { useEffect, useState } from 'preact/hooks';
import { AuthRequiredError, type RepoGateway, type Repository } from '../domain';
import { describeError } from '../workspace/model';
import { RepoList } from '../ui/RepoList';

export interface RepoPickerProps {
  gateway: RepoGateway;
  onOpen: (repo: Repository) => void;
  onAuthRequired: () => void;
}

export function RepoPicker({ gateway, onOpen, onAuthRequired }: RepoPickerProps) {
  const [repos, setRepos] = useState<Repository[]>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setError(undefined);
    gateway.listRepositories().then(
      (list) => active && setRepos(list),
      (err: unknown) => {
        if (!active) return;
        if (err instanceof AuthRequiredError) onAuthRequired();
        else setError(describeError(err));
      },
    );
    return () => {
      active = false;
    };
  }, [gateway, onAuthRequired, attempt]);

  return (
    <main class="page">
      <h2>Choose a repository</h2>
      {error ? (
        <div class="banner banner-error" role="alert">
          {error}{' '}
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : repos ? (
        <RepoList repos={repos} onOpen={onOpen} />
      ) : (
        <p class="muted">Loading repositories…</p>
      )}
    </main>
  );
}
