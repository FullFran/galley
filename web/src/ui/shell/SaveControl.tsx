import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useT } from '../../i18n';
import { matchShortcut, typingInField } from '../../shell/shortcuts';
import { saveStateLabel } from '../../workspace/session';
import { Icon } from './icons';

export interface SaveControlProps {
  dirtyCount: number;
  message: string;
  placeholder: string;
  saving: boolean;
  /** Bumped to open the note (the phone ⋯ menu's "Add a note…"). */
  noteRequest?: number;
  /** Between the state and the button: the header ⋯ menu. */
  more?: ComponentChildren;
  onMessage: (message: string) => void;
  onSave: () => void;
  /** New sections and uploads in this save, in plain words; uploads can be removed. */
  pending?: { key: string; text: string; onRemove?: () => void }[];
}

/**
 * Header save: a dot and "1 unsaved" (role=status, full wording in the
 * tooltip) and a split "Save for review" button whose caret opens the
 * optional note. Ctrl/Cmd+S opens the note too, so Enter saves.
 */
export function SaveControl({ dirtyCount, message, placeholder, saving, noteRequest, more, onMessage, onSave, pending = [] }: SaveControlProps) {
  const t = useT();
  const m = t.save;
  const [noteOpen, setNoteOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const caret = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (noteRequest) setNoteOpen(true);
  }, [noteRequest]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchShortcut(e, typingInField(e.target)) !== 'save') return;
      // Never the browser's "Save page as".
      e.preventDefault();
      e.stopPropagation();
      setNoteOpen(true);
      input.current?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    if (!noteOpen) return;
    input.current?.focus();
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return;
        setNoteOpen(false);
        // Phones have no caret; the focus then goes back to the main button.
        const back = caret.current && caret.current.getClientRects().length > 0 ? caret.current : root.current?.querySelector<HTMLElement>('.save-main');
        back?.focus();
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
      <span
        class={dirtyCount > 0 ? 'save-state save-state-dirty' : 'save-state'}
        role="status"
        title={saveStateLabel(dirtyCount, saving, t)}
      >
        {dirtyCount > 0 && !saving && <span class="save-dot" aria-hidden="true" />}
        {saving ? m.saving : dirtyCount > 0 ? m.unsavedShort(dirtyCount) : m.allSavedShort}
        <span class="visually-hidden">{` (${saveStateLabel(dirtyCount, saving, t)})`}</span>
      </span>
      {more}
      <form class="save-form split-button" onSubmit={submit}>
        {/* Phones show the short label; the full one stays the accessible name. */}
        <button
          type="submit"
          class="primary save-main"
          disabled={disabled}
          aria-label={saving ? undefined : m.button}
          aria-keyshortcuts="Control+S Meta+S"
        >
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
        <button
          type="button"
          ref={caret}
          class="primary save-caret"
          aria-label={m.addNote}
          data-tooltip={noteOpen ? undefined : m.addNote}
          aria-expanded={noteOpen}
          aria-controls="save-note"
          onClick={() => setNoteOpen((o) => !o)}
        >
          <Icon name="chevron" />
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
          {pending.length > 0 && (
            <div class="save-pending">
              <p class="save-pending-title">{t.authoring.pendingTitle}</p>
              <ul>
                {pending.map((item) => (
                  <li key={item.key}>
                    <span>{item.text}</span>
                    {item.onRemove && (
                      <button type="button" class="link" aria-label={t.authoring.removeLabel(item.text)} onClick={item.onRemove}>
                        {t.authoring.remove}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </form>
    </div>
  );
}
