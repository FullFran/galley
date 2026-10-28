import { useState } from 'preact/hooks';
import { useT } from '../../i18n';
import { isOwner } from '../../team/codeowners';
import { isDueDate, MAX_NOTE } from '../../team/asks';
import { Modal } from '../shell/Modal';
import './team.css';

// Dialogs of the team features, loaded on demand: Ask someone, Edit owners.

export interface AskForm {
  assignee: string;
  due: string;
  note: string;
}

export interface AskDialogProps {
  what: string;
  people: string[];
  /** `YYYY-MM-DD`, the earliest allowed due date. */
  today: string;
  busy: boolean;
  error?: string;
  onSubmit: (form: AskForm) => void;
  onClose: () => void;
}

export function AskDialog({ what, people, today, busy, error, onSubmit, onClose }: AskDialogProps) {
  const t = useT().team;
  const [form, setForm] = useState<AskForm>({ assignee: '', due: '', note: '' });
  const late = form.due !== '' && isDueDate(form.due) && form.due < today;
  const ready = form.assignee !== '' && isDueDate(form.due) && !late && !busy;
  return (
    <Modal open onClose={onClose} labelledBy="ask-title" class="team-dialog">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onSubmit(form);
        }}
      >
        <h2 id="ask-title">{t.askTitle(what)}</h2>
        <div class="form-grid">
          <label>
            {t.person}
            <select name="assignee" required value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.currentTarget.value })}>
              <option value="">{t.choosePerson}</option>
              {people.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t.due}
            <input type="date" name="due" required min={today} value={form.due} onInput={(e) => setForm({ ...form, due: e.currentTarget.value })} />
          </label>
          {late && <p class="field-error">{t.pastDate}</p>}
          <label>
            {t.note}
            <textarea name="note" rows={3} maxLength={MAX_NOTE} value={form.note} onInput={(e) => setForm({ ...form, note: e.currentTarget.value })} />
          </label>
        </div>
        <p class="muted">{t.assignNote}</p>
        {error && (
          <p class="notice notice-danger" role="alert">
            {error}
          </p>
        )}
        <div class="actions">
          <button type="button" onClick={onClose}>
            {t.cancel}
          </button>
          <button type="submit" class="primary" disabled={!ready}>
            {busy ? t.sending : t.send}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export interface OwnersDialogProps {
  name: string;
  owners: string[];
  error?: string;
  onSubmit: (owners: string[]) => void;
  onClose: () => void;
}

export const splitOwners = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.includes('@') ? s : `@${s}`));

export function OwnersDialog({ name, owners, error, onSubmit, onClose }: OwnersDialogProps) {
  const t = useT().team;
  const [text, setText] = useState(owners.join(' '));
  const list = splitOwners(text);
  const bad = list.find((o) => !isOwner(o));
  return (
    <Modal open onClose={onClose} labelledBy="owners-title" class="team-dialog">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!bad) onSubmit([...new Set(list)]);
        }}
      >
        <h2 id="owners-title">{t.ownersTitle(name)}</h2>
        <p class="muted">{t.ownersLead}</p>
        <div class="form-grid">
          <label>
            {t.ownersField}
            <input type="text" name="owners" autoFocus maxLength={500} value={text} onInput={(e) => setText(e.currentTarget.value)} />
          </label>
        </div>
        {bad && <p class="field-error">{t.invalidOwner(bad)}</p>}
        {error && (
          <p class="notice notice-danger" role="alert">
            {error}
          </p>
        )}
        <p class="notice notice-warn" role="note">
          {t.writeWarning}
        </p>
        <div class="actions">
          <button type="button" onClick={onClose}>
            {t.cancel}
          </button>
          <button type="submit" class="primary" disabled={bad !== undefined}>
            {t.saveOwners}
          </button>
        </div>
      </form>
    </Modal>
  );
}
