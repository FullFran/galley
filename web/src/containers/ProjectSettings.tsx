import { useEffect, useState } from 'preact/hooks';
import { AuthRequiredError, ConflictError, type RepoGateway, type Repository, type WorkingState } from '../domain';
import { checkDraft } from '../config/form';
import type { ProjectConfig } from '../config/project';
import { CONFIG_PATH, parseConfig, type GalleyConfig } from '../config/schema';
import { suggestConfig } from '../config/wizard';
import { describeError } from '../workspace/model';
import { useT } from '../i18n';
import { ConfigForm } from '../ui/config/ConfigForm';

export interface ConfigSaved {
  headSha: string;
  content: string;
  /** The saved file, parsed. */
  project: ProjectConfig;
  pullRequestUrl?: string;
}

export interface ProjectSettingsProps {
  gateway: RepoGateway;
  repo: Repository;
  working: WorkingState;
  project: ProjectConfig;
  onSaved: (saved: ConfigSaved) => void;
  onCancel: () => void;
  onAuthRequired: () => void;
}

/**
 * Setup wizard (no `.galley.yml` yet) and settings screen for repository
 * admins. Saving proposes the file like any other galley save: one commit on
 * the working branch and its pull request.
 */
export function ProjectSettings({ gateway, repo, working, project, onSaved, onCancel, onAuthRequired }: ProjectSettingsProps) {
  const t = useT();
  const [draft, setDraft] = useState<GalleyConfig | undefined>(project.kind === 'valid' ? project.config : undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (draft) return;
    let cancelled = false;
    const source = {
      files: working.files,
      readText: (path: string) => gateway.readFile(repo, path, working.headSha),
      readBytes: (path: string) => gateway.readBytes(repo, path, working.headSha),
    };
    suggestConfig(source)
      .then((suggested) => !cancelled && setDraft(suggested))
      .catch(() => !cancelled && setDraft({ version: 1, editable: [], uploads: [], labels: {}, preview: { autoCompile: false } }));
    return () => {
      cancelled = true;
    };
  }, [draft, gateway, repo, working]);

  if (!draft) return <p class="muted">{t.config.reading}</p>;

  const save = async () => {
    const { text, problems } = checkDraft(draft);
    if (problems.some((p) => p.severity === 'error')) return;
    setSaving(true);
    setError(undefined);
    const message = project.kind === 'missing' ? t.config.commitSetup(CONFIG_PATH) : t.config.commitUpdate(CONFIG_PATH);
    try {
      const result = await gateway.save(repo, [{ path: CONFIG_PATH, content: text }], message, working.headSha);
      const parsed = parseConfig(text);
      const saved: ProjectConfig = parsed.config
        ? { kind: 'valid', config: parsed.config, problems: parsed.problems }
        : { kind: 'invalid', problems: parsed.problems };
      onSaved({ headSha: result.commitSha, content: text, project: saved, pullRequestUrl: result.pullRequestUrl });
    } catch (err) {
      if (err instanceof AuthRequiredError) return onAuthRequired();
      setError(
        err instanceof ConflictError
          ? t.config.conflict
          : describeError(err, t),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <ConfigForm
      mode={project.kind === 'missing' ? 'setup' : 'settings'}
      files={working.files}
      draft={draft}
      repoProblems={project.kind === 'missing' ? [] : project.problems}
      branch={working.branch}
      saving={saving}
      error={error}
      onChange={setDraft}
      onSave={() => void save()}
      onCancel={onCancel}
    />
  );
}
