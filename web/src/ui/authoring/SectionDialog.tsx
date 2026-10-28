import { useT } from '../../i18n';
import { Modal } from '../shell/Modal';

export interface SectionForm {
  kind: 'section' | 'subsection';
  title: string;
  /** Section: the include line it follows, or `start`. */
  after: number | 'start';
  /** Subsection: key of the chosen parent. */
  parent: string;
  /** Advanced overrides; empty means galley's proposal. */
  fileName: string;
  id: string;
  advanced: boolean;
}

export interface SectionCheck {
  problems: string[];
  warnings: string[];
  /** File and id galley will use. */
  path?: string;
  id: string;
  /** Folder new section files go to. */
  folder: string;
}

export interface SectionDialogProps {
  open: boolean;
  loading: boolean;
  failed: boolean;
  form: SectionForm;
  positions: { value: number | 'start'; label: string }[];
  parents: { key: string; label: string }[];
  check?: SectionCheck;
  onChange: (form: SectionForm) => void;
  onSubmit: () => void;
  onClose: () => void;
}

/** New section / New subsection: title, kind, position, and file name and id under Advanced. */
export function SectionDialog({ open, loading, failed, form, positions, parents, check, onChange, onSubmit, onClose }: SectionDialogProps) {
  const a = useT().authoring;
  const set = (patch: Partial<SectionForm>) => onChange({ ...form, ...patch });
  const ready = !loading && !failed && check !== undefined;
  const blocked = !ready || check.problems.length > 0;
  const section = form.kind === 'section';
  // Errors show once the person typed a title, so the dialog does not open red.
  const shown = check && (form.title.trim() !== '' ? check.problems : check.problems.filter((p) => p !== a.problems['title-empty']));
  return (
    <Modal open={open} onClose={onClose} labelledBy="section-title" class="authoring-dialog">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked) onSubmit();
        }}
      >
        <h2 id="section-title">{section ? a.dialogSection : a.dialogSubsection}</h2>
        <div class="form-grid">
          <label>
            {a.title}
            <input
              type="text"
              name="title"
              maxLength={200}
              required
              value={form.title}
              autoFocus
              onInput={(e) => set({ title: e.currentTarget.value })}
            />
          </label>
          <label>
            {a.kind}
            <select name="kind" value={form.kind} onChange={(e) => set({ kind: e.currentTarget.value === 'subsection' ? 'subsection' : 'section' })}>
              <option value="section">{a.kindSection}</option>
              <option value="subsection">{a.kindSubsection}</option>
            </select>
          </label>
          {section ? (
            <label>
              {a.position}
              <select
                name="position"
                value={String(form.after)}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  set({ after: v === 'start' ? 'start' : Number(v) });
                }}
              >
                {positions.map((p) => (
                  <option key={String(p.value)} value={String(p.value)}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              {a.parent}
              <select name="parent" value={form.parent} onChange={(e) => set({ parent: e.currentTarget.value })}>
                {parents.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <details open={form.advanced} onToggle={(e) => set({ advanced: (e.currentTarget as HTMLDetailsElement).open })}>
            <summary>{a.advanced}</summary>
            {section && (
              <label>
                {a.fileName}
                <input
                  type="text"
                  name="file"
                  maxLength={64}
                  value={form.fileName}
                  placeholder={check?.path?.slice(check.folder.length)}
                  onInput={(e) => set({ fileName: e.currentTarget.value })}
                />
                <span class="muted field-hint">{a.fileNameIn(check?.folder ?? '')}</span>
              </label>
            )}
            <label>
              {a.id}
              <input type="text" name="id" maxLength={64} value={form.id} placeholder={check?.id} onInput={(e) => set({ id: e.currentTarget.value })} />
              {check && <span class="muted field-hint">{a.idHint(form.id.trim() || check.id)}</span>}
            </label>
          </details>
        </div>
        {loading && <p class="muted">{a.loading}</p>}
        {failed && (
          <p class="notice notice-danger" role="alert">
            {a.readFailed}
          </p>
        )}
        {shown && shown.length > 0 && (
          <ul class="notice notice-danger form-problems" role="alert">
            {shown.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {check && check.warnings.length > 0 && (
          <ul class="notice notice-warn form-problems">
            {check.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        {ready && check.problems.length === 0 && (
          <p class="muted">{section && check.path ? a.willCreate(check.path) : a.pendingNote}</p>
        )}
        <div class="actions">
          <button type="submit" class="primary" disabled={blocked}>
            {a.add}
          </button>
          <button type="button" onClick={onClose}>
            {a.cancel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
