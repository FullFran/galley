export interface SaveBarProps {
  dirtyCount: number;
  message: string;
  placeholder: string;
  saving: boolean;
  onMessage: (message: string) => void;
  onSave: () => void;
}

export function SaveBar({ dirtyCount, message, placeholder, saving, onMessage, onSave }: SaveBarProps) {
  return (
    <form
      class="save-bar"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <label>
        <span class="muted">
          {dirtyCount === 0 ? 'No unsaved changes' : `${dirtyCount} file${dirtyCount === 1 ? '' : 's'} with unsaved changes`}
        </span>
        <input
          type="text"
          maxLength={200}
          value={message}
          placeholder={placeholder}
          aria-label="Short description of your changes"
          onInput={(e) => onMessage(e.currentTarget.value)}
        />
      </label>
      <button type="submit" class="primary" disabled={dirtyCount === 0 || saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}
