import { useEffect, useRef, useState } from 'preact/hooks';
import { useT } from '../../i18n';
import { saveStateLabel } from '../../workspace/session';
import { Icon } from './icons';

export interface SaveControlProps {
  dirtyCount: number;
  message: string;
  placeholder: string;
  saving: boolean;
  onMessage: (message: string) => void;
  onSave: () => void;
}

/**
 * Header save: the state ("All changes saved", "2 unsaved files"), one primary
 * "Save for review" button and an optional note in a small popover.
 */
export function SaveControl({ dirtyCount, message, placeholder, saving, onMessage, onSave }: SaveControlProps) {
  const t = useT();
  const m = t.save;
  const [noteOpen, setNoteOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const noteButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!noteOpen) return;
    input.current?.focus();
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return;
        setNoteOpen(false);
        noteButton.current?.focus();
        return;
      }
      if (!root.current?.contains(e.target as Node)) setNoteOpen(false);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', close);
    return () => {
      document.removeEventListener('keydown', close);
      document.removeEventListener('pointerdown', close);
    };
  }, [noteOpen]);

  const disabled = dirtyCount === 0 || saving;
  const submit = (e: Event) => {
    e.preventDefault();
    setNoteOpen(false);
    onSave();
  };

  return (
    <div class="save-control" data-tour="save" ref={root}>
      <span class={dirtyCount > 0 ? 'save-state save-state-dirty' : 'save-state'} role="status">
        {saveStateLabel(dirtyCount, saving, t)}
      </span>
      <form class="save-form" onSubmit={submit}>
        <button
          type="button"
          ref={noteButton}
          class="icon-button note-toggle"
          aria-label={m.addNote}
          data-tooltip={m.addNote}
          aria-expanded={noteOpen}
          aria-controls="save-note"
          onClick={() => setNoteOpen((o) => !o)}
        >
          <Icon name="chevron" />
        </button>
        {/* Phones show the short label; the full one stays the accessible name. */}
        <button type="submit" class="primary" disabled={disabled} aria-label={saving ? undefined : m.button}>
          {saving ? (
            m.saving
          ) : (
            <>
              <span class="save-long">{m.button}</span>
              <span class="save-short" aria-hidden="true">
                {m.buttonShort}
              </span>
            </>
          )}
        </button>
        <div id="save-note" class="popover" hidden={!noteOpen}>
          <label>
            {m.noteLabel}
            <input
              ref={input}
              type="text"
              maxLength={200}
              value={message}
              placeholder={placeholder}
              onInput={(e) => onMessage(e.currentTarget.value)}
            />
          </label>
          <p class="muted">{m.noteHint}</p>
        </div>
      </form>
    </div>
  );
}
