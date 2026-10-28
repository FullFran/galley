import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { MAX_CHAT_BYTES, type ChatMessage } from '../../chat/http';
import { useT } from '../../i18n';
import { formatDateTime } from '../../i18n/format';
import { Icon } from '../shell/icons';
import './chat.css';

// The chat panel: the history (earlier pages on demand), plain-text messages
// with author and time, and the composer. Loaded on first open.

export interface ChatPanelProps {
  messages: ChatMessage[];
  hasMore: boolean;
  loadingEarlier: boolean;
  status: 'loading' | 'ready' | 'error';
  onEarlier: () => void;
  /** Resolves to an error to show, or undefined once sent. */
  onSend: (body: string) => Promise<string | undefined>;
  onClose: () => void;
  onRetry: () => void;
}

const encoder = new TextEncoder();
const NEAR_BOTTOM = 48;

export function ChatPanel({ messages, hasMore, loadingEarlier, status, onEarlier, onSend, onClose, onRetry }: ChatPanelProps) {
  const t = useT();
  const m = t.chat;
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const firstSeq = useRef<number>(undefined);
  const height = useRef(0);

  // New messages keep the view at the bottom (when it was there); an earlier
  // page keeps the message that was on top in place.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const first = messages[0]?.seq;
    if (firstSeq.current !== undefined && first !== undefined && first < firstSeq.current) el.scrollTop += el.scrollHeight - height.current;
    else if (stick.current) el.scrollTop = el.scrollHeight;
    firstSeq.current = first;
    height.current = el.scrollHeight;
  }, [messages]);

  const bytes = encoder.encode(text).length;
  const left = MAX_CHAT_BYTES - bytes;
  const blank = !text.trim();

  const submit = async () => {
    if (sending || blank) return;
    if (left < 0) return setError(m.tooLong);
    setSending(true);
    setError(undefined);
    const problem = await onSend(text);
    setSending(false);
    if (problem) setError(problem);
    else {
      setText('');
      stick.current = true;
    }
  };

  return (
    <aside class="comments-panel chat-panel" aria-label={m.title}>
      <header class="comments-head">
        <h2>{m.title}</h2>
        <button type="button" class="icon-button" aria-label={m.close} data-tooltip={m.close} onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div
        class="chat-list"
        ref={list}
        role="log"
        aria-label={m.messages}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
        }}
      >
        {hasMore && (
          <button type="button" class="chat-earlier" disabled={loadingEarlier} onClick={onEarlier}>
            {loadingEarlier ? m.loadingEarlier : m.earlier}
          </button>
        )}
        {status === 'loading' && messages.length === 0 && <p class="muted chat-note">{m.loading}</p>}
        {status === 'error' && (
          <div class="chat-note">
            <p>{m.unavailable}</p>
            <button type="button" onClick={onRetry}>
              {m.tryAgain}
            </button>
          </div>
        )}
        {status === 'ready' && messages.length === 0 && <p class="muted chat-note">{m.empty}</p>}
        <ol class="chat-messages">
          {messages.map((msg) => (
            <li key={msg.seq} class={msg.mine ? 'chat-msg chat-msg-mine' : 'chat-msg'}>
              <div class="chat-meta">
                <span class="chat-author">{msg.mine ? m.you : msg.author.kind === 'ai' ? m.ai(msg.author.login) : msg.author.login}</span>
                <time dateTime={msg.createdAt}>{formatDateTime(msg.createdAt, t.meta.lang)}</time>
              </div>
              <p class="chat-body">{msg.body}</p>
            </li>
          ))}
        </ol>
      </div>
      <form
        class="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label class="visually-hidden" for="chat-input">
          {m.label}
        </label>
        <textarea
          id="chat-input"
          rows={2}
          value={text}
          placeholder={m.placeholder}
          aria-describedby="chat-hint"
          aria-invalid={left < 0 ? 'true' : undefined}
          onInput={(e) => {
            setText(e.currentTarget.value);
            if (error) setError(undefined);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
            e.preventDefault();
            void submit();
          }}
        />
        <div class="chat-composer-row">
          <span id="chat-hint" class={error || left < 0 ? 'chat-hint chat-hint-error' : 'chat-hint muted'} role={error ? 'alert' : undefined}>
            {error ?? (left < 512 ? m.bytesLeft(Math.max(0, left)) : m.hint)}
          </span>
          <button type="submit" class="primary" disabled={sending || blank || left < 0}>
            {m.send}
          </button>
        </div>
      </form>
    </aside>
  );
}
