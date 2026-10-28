import { useEffect, useState } from 'preact/hooks';
import { AuthRequiredError, type RepoGateway, type Repository } from '../domain';
import { describeError } from '../workspace/model';
import { useT, useTRef } from '../i18n';
import { RepoList } from '../ui/RepoList';
import { AppShell, type ShellContext } from '../ui/shell/AppShell';
import { Skeleton } from '../ui/shell/Skeleton';

export interface RepoPickerProps {
  gateway: RepoGateway;
  onOpen: (repo: Repository) => void;
  onAuthRequired: () => void;
  shell: ShellContext;
}

export function RepoPicker({ gateway, onOpen, onAuthRequired, shell }: RepoPickerProps) {
  const t = useT();
  const tRef = useTRef();
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
        else setError(describeError(err, tRef.current));
      },
    );
    return () => {
      active = false;
    };
  }, [gateway, onAuthRequired, attempt, tRef]);

  return (
    <AppShell shell={shell} active="repos" crumbs={[t.nav.repos]}>
      <div class="page">
        <h1>{t.repos.title}</h1>
        <p class="muted">{t.repos.intro}</p>
        {error ? (
          <div class="notice notice-danger" role="alert">
            <p>{error}</p>
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              {t.repos.tryAgain}
            </button>
          </div>
        ) : repos ? (
          <RepoList repos={repos} onOpen={onOpen} onReload={() => setAttempt((n) => n + 1)} />
        ) : (
          <Skeleton variant="list" lines={4} />
        )}
      </div>
    </AppShell>
  );
}
