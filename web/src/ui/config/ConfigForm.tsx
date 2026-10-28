import { useState } from 'preact/hooks';
import { candidateFiles, checkDraft, coveredBy, parseAccept, togglePattern } from '../../config/form';
import { globError, isPlainPath } from '../../config/glob';
import { visibleFiles } from '../../config/project';
import { DEFAULT_ACCEPT, DEFAULT_UPLOAD_MB, type ConfigProblem, type GalleyConfig, type UploadRule } from '../../config/schema';
import { ProblemList } from './ViewNotice';

export interface ConfigFormProps {
  mode: 'setup' | 'settings';
  /** Every file at the working head. */
  files: readonly string[];
  draft: GalleyConfig;
  /** Problems of the `.galley.yml` currently in the repository. */
  repoProblems: ConfigProblem[];
  branch: string;
  saving: boolean;
  error?: string;
  onChange: (draft: GalleyConfig) => void;
  onSave: () => void;
  onCancel: () => void;
}

/** The setup wizard and the settings screen: one form over a `.galley.yml` draft. */
export function ConfigForm({ mode, files, draft, repoProblems, branch, saving, error, onChange, onSave, onCancel }: ConfigFormProps) {
  const [pattern, setPattern] = useState('');
  const { text, problems } = checkDraft(draft);
  const blocked = problems.some((p) => p.severity === 'error');
  const visible = visibleFiles(files, { kind: 'valid', config: draft, problems: [] }, false);
  const documents = candidateFiles(files);
  const globs = draft.editable.filter((p) => !isPlainPath(p) || !documents.includes(p));
  const entries = files.filter((f) => /\.(qmd|md)$/i.test(f) && !f.split('/').some((s) => s.startsWith('.')));
  const patternError = pattern ? globError(pattern) : undefined;
  const setUpload = (i: number, change: Partial<UploadRule>) =>
    onChange({ ...draft, uploads: draft.uploads.map((u, j) => (j === i ? { ...u, ...change } : u)) });

  return (
    <form
      class="config-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!blocked) onSave();
      }}
    >
      <h2>{mode === 'setup' ? 'Set up galley for this paper' : 'Project settings'}</h2>
      <p class="muted">
        {mode === 'setup'
          ? 'galley suggested these settings from the repository. Check them, then save. '
          : 'These settings live in .galley.yml in the repository. '}
        Saving adds .galley.yml to your proposal on {branch}; it applies to everyone once the proposal is merged. The file
        list only shapes what galley shows; it is not a GitHub permission.
      </p>
      {repoProblems.length > 0 && (
        <div class="banner banner-error">
          <p>The .galley.yml in the repository has problems; galley uses safe defaults until it is fixed:</p>
          <ProblemList problems={repoProblems} />
        </div>
      )}

      <fieldset>
        <legend>Paper</legend>
        <label>
          Display name
          <input
            type="text"
            maxLength={120}
            value={draft.title ?? ''}
            onInput={(e) => onChange({ ...draft, title: e.currentTarget.value || undefined })}
          />
        </label>
        <label>
          Main file
          <select value={draft.entry ?? ''} onChange={(e) => onChange({ ...draft, entry: e.currentTarget.value || undefined })}>
            <option value="">From _quarto.yml (or index.qmd)</option>
            {entries.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset>
        <legend>Files co-authors can edit</legend>
        <ul class="config-files">
          {globs.map((p) => (
            <li key={`g:${p}`}>
              <label>
                <input type="checkbox" checked onChange={() => onChange(togglePattern(draft, p, false))} /> <code>{p}</code>
              </label>
            </li>
          ))}
          {documents.map((f) => {
            const by = coveredBy(f, draft.editable);
            return (
              <li key={`f:${f}`}>
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(by) || draft.editable.includes(f)}
                    disabled={Boolean(by)}
                    onChange={(e) => onChange(togglePattern(draft, f, e.currentTarget.checked))}
                  />{' '}
                  {f}
                  {by && <span class="muted"> (included by {by})</span>}
                </label>
              </li>
            );
          })}
        </ul>
        <div class="config-add">
          <input
            type="text"
            maxLength={200}
            value={pattern}
            placeholder="Add a file or pattern, e.g. sections/*.qmd"
            aria-label="File or pattern to add"
            onInput={(e) => setPattern(e.currentTarget.value.trim())}
          />
          <button
            type="button"
            disabled={!pattern || Boolean(patternError)}
            onClick={() => {
              onChange(togglePattern(draft, pattern, true));
              setPattern('');
            }}
          >
            Add
          </button>
        </div>
        {patternError && <p class="muted">This pattern {patternError}</p>}
        <p class="muted">* matches within one folder, ** across folders, ? one character. Hidden files are never matched.</p>
        <details>
          <summary>
            Co-authors will see {visible.length} file{visible.length === 1 ? '' : 's'}
          </summary>
          <ul class="config-visible">
            {visible.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </details>
      </fieldset>

      <fieldset>
        <legend>Upload folders</legend>
        {draft.uploads.map((u, i) => (
          <div class="config-upload" key={i}>
            <label>
              Folder
              <input type="text" maxLength={200} value={u.folder} onInput={(e) => setUpload(i, { folder: e.currentTarget.value })} />
            </label>
            <label>
              File types
              <input
                type="text"
                value={u.accept.join(', ')}
                onChange={(e) => setUpload(i, { accept: parseAccept(e.currentTarget.value) })}
              />
            </label>
            <label>
              Max size (MB)
              <input
                type="number"
                min={1}
                max={25}
                step="any"
                value={u.maxSizeMb}
                onInput={(e) => setUpload(i, { maxSizeMb: e.currentTarget.valueAsNumber })}
              />
            </label>
            <button type="button" onClick={() => onChange({ ...draft, uploads: draft.uploads.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            onChange({ ...draft, uploads: [...draft.uploads, { folder: 'figures/', accept: [...DEFAULT_ACCEPT], maxSizeMb: DEFAULT_UPLOAD_MB }] })
          }
        >
          Add upload folder
        </button>
      </fieldset>

      <fieldset>
        <legend>Names shown for files</legend>
        <details>
          <summary>Friendly names ({Object.values(draft.labels).filter(Boolean).length})</summary>
          {visible.map((f) => (
            <label key={f} class="config-label">
              {f}
              <input
                type="text"
                maxLength={120}
                value={draft.labels[f] ?? ''}
                onInput={(e) => {
                  const name = e.currentTarget.value;
                  const labels = Object.fromEntries(Object.entries(draft.labels).filter(([k]) => k !== f));
                  onChange({ ...draft, labels: name ? { ...labels, [f]: name } : labels });
                }}
              />
            </label>
          ))}
        </details>
      </fieldset>

      <fieldset>
        <legend>Preview</legend>
        <label>
          <input
            type="checkbox"
            checked={draft.preview.autoCompile}
            onChange={(e) => onChange({ ...draft, preview: { autoCompile: e.currentTarget.checked } })}
          />{' '}
          Compile automatically while typing (default for new users; each person can change it)
        </label>
      </fieldset>

      {problems.length > 0 && <ProblemList problems={problems} />}
      {error && (
        <p class="banner banner-error" role="alert">
          {error}
        </p>
      )}
      <details>
        <summary>Show .galley.yml</summary>
        <pre class="config-yaml">{text}</pre>
      </details>
      <div class="config-actions">
        <button type="submit" class="primary" disabled={blocked || saving}>
          {saving ? 'Saving…' : mode === 'setup' ? 'Save and propose .galley.yml' : 'Save settings to proposal'}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
