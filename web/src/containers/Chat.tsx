import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { AuthRequiredError, type Repository } from '../domain';
import { InvalidCommentError, RateLimitedError } from '../domain/comments';
import { PayloadTooLargeError } from '../galley/api';
import { chatBodyProblem, type ChatGateway, type ChatMessage } from '../chat/http';
import { incoming, mergeMessages, newestSeq } from '../chat/model';
import { takeChatPanelRequest } from '../chat/panelRequest';
import { createChatStream } from '../chat/stream';
import { useTRef, type Messages } from '../i18n';

// The paper's chat: history, the live stream and the unread badge stay
// here, in the main bundle (small); the panel itself loads on first open.

type PanelModule = typeof import('../ui/chat/ChatPanel');
const loadPanel = () => import('../ui/chat/ChatPanel');

export interface UseChatOptions {
  gateway?: ChatGateway;
  repo: Repository;
  onAuthRequired: () => void;
}

export function chatErrorMessage(err: unknown, t: Messages): string {
  const m = t.chat;
  if (err instanceof RateLimitedError) return m.rateLimited(err.retryAfterSeconds);
  if (err instanceof PayloadTooLargeError) return m.tooLong;
  if (err instanceof InvalidCommentError) return m.invalid;
  return m.failed;
}

const isVisible = () => globalThis.document?.visibilityState !== 'hidden';

export function useChat(o: UseChatOptions) {
  const tRef = useTRef();
  const { gateway, repo } = o;
  const opts = useRef(o);
  opts.current = o;
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [earlier, setEarlier] = useState(false);
  const [unread, setUnread] = useState(0);
  const [panel, setPanel] = useState<PanelModule>();
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const viewing = useRef(false);
  viewing.current = open && isVisible();
  const readUpTo = useRef(0);

  const markRead = useCallback(
    (seq: number) => {
      if (!gateway || seq <= readUpTo.current) return;
      readUpTo.current = seq;
      gateway.markRead(repo.id, seq).catch(() => undefined);
    },
    [gateway, repo.id],
  );

  const loadNewest = useCallback(async () => {
    if (!gateway) return;
    try {
      const page = await gateway.history(repo.id);
      setMessages(page.messages);
      setHasMore(page.hasMore);
      setStatus('ready');
    } catch (err) {
      if (err instanceof AuthRequiredError) opts.current.onAuthRequired();
      setStatus('error');
    }
  }, [gateway, repo.id]);

  // History first, then the stream from the newest message held.
  useEffect(() => {
    if (!gateway) return;
    if (takeChatPanelRequest()) setOpen(true);
    let alive = true;
    gateway.unread(repo.id).then(
      (u) => {
        if (!alive) return;
        readUpTo.current = u.lastReadSeq;
        setUnread(u.unread);
      },
      () => undefined,
    );
    const stream = createChatStream({
      url: (seq) => gateway.streamUrl(repo.id, seq),
      lastSeq: () => newestSeq(messagesRef.current),
      onMessage: (m) => {
        messagesRef.current = mergeMessages(messagesRef.current, [m]);
        setMessages(messagesRef.current);
        const now = viewing.current;
        setUnread((u) => incoming({ unread: u }, m, now).unread);
        if (now) markRead(m.seq);
      },
      onResync: () => void loadNewest(),
    });
    void loadNewest().then(() => alive && stream.start());
    return () => {
      alive = false;
      stream.stop();
    };
  }, [gateway, repo.id, loadNewest, markRead]);

  // Reading: an open panel in a visible tab marks everything read.
  useEffect(() => {
    if (!open || status !== 'ready') return;
    const read = () => {
      if (!isVisible()) return;
      setUnread(0);
      markRead(newestSeq(messagesRef.current));
    };
    read();
    document.addEventListener('visibilitychange', read);
    return () => document.removeEventListener('visibilitychange', read);
  }, [open, status, messages, markRead]);

  useEffect(() => {
    if (open && !panel) loadPanel().then(setPanel, () => setStatus('error'));
  }, [open, panel]);

  const loadEarlier = async () => {
    const first = messagesRef.current[0];
    if (!gateway || !first || earlier) return;
    setEarlier(true);
    try {
      const page = await gateway.history(repo.id, first.seq);
      messagesRef.current = mergeMessages(page.messages, messagesRef.current);
      setMessages(messagesRef.current);
      setHasMore(page.hasMore);
    } catch (err) {
      if (err instanceof AuthRequiredError) opts.current.onAuthRequired();
    } finally {
      setEarlier(false);
    }
  };

  /** Sends `body`; resolves to an error message, or undefined once sent. */
  const send = async (body: string): Promise<string | undefined> => {
    const t = tRef.current;
    const problem = chatBodyProblem(body);
    if (problem === 'blank') return undefined;
    if (problem === 'too-long') return t.chat.tooLong;
    if (problem === 'invalid') return t.chat.invalid;
    if (!gateway) return t.chat.failed;
    try {
      const m = await gateway.post(repo.id, body);
      messagesRef.current = mergeMessages(messagesRef.current, [m]);
      setMessages(messagesRef.current);
      return undefined;
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        opts.current.onAuthRequired();
        return undefined;
      }
      return chatErrorMessage(err, t);
    }
  };

  const view =
    gateway && open && panel ? (
      <panel.ChatPanel
        messages={messages}
        hasMore={hasMore}
        loadingEarlier={earlier}
        status={status}
        onEarlier={() => void loadEarlier()}
        onSend={send}
        onClose={() => setOpen(false)}
        onRetry={() => void loadNewest()}
      />
    ) : undefined;

  return {
    enabled: gateway !== undefined,
    open,
    toggle: () => setOpen((v) => !v),
    close: () => setOpen(false),
    unread,
    panel: view,
  };
}
