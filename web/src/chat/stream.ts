import { parseChatMessage, type ChatMessage } from './http';

// The live chat stream over EventSource, with the session cookie. Every
// failure (network, an HTTP error, the server ending the stream) closes the
// connection and reopens it after an exponential backoff, from the newest
// message held (`last_event_id`), so nothing is lost and a dead session does
// not hammer the server. `resync` means more was missed than the server
// replays: reload the history. A tab hidden for a while closes the stream;
// showing it again reopens it.

export interface EventSourceLike {
  addEventListener(type: string, listener: (e: MessageEvent) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string, init: { withCredentials: boolean }) => EventSourceLike;

export interface ChatStreamOptions {
  url: (lastSeq: number) => string;
  lastSeq: () => number;
  onMessage: (m: ChatMessage) => void;
  onResync: () => void;
  create?: EventSourceFactory;
  visible?: () => boolean;
  /** Where `visibilitychange` arrives; document by default. */
  events?: EventTarget;
  hiddenCloseMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 0..1, for jitter (up to +20 %). */
  random?: () => number;
}

const defaultCreate: EventSourceFactory = (url, init) => new EventSource(url, init);

export function createChatStream(o: ChatStreamOptions) {
  const create = o.create ?? defaultCreate;
  const visible = o.visible ?? (() => globalThis.document?.visibilityState !== 'hidden');
  const events: EventTarget | undefined = o.events ?? globalThis.document;
  const hiddenCloseMs = o.hiddenCloseMs ?? 120_000;
  const base = o.baseDelayMs ?? 1_000;
  const max = o.maxDelayMs ?? 60_000;
  const random = o.random ?? Math.random;
  let source: EventSourceLike | undefined;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let paused = false;

  const close = () => {
    source?.close();
    source = undefined;
  };

  const open = () => {
    clearTimeout(retry);
    retry = undefined;
    if (!running || paused || source) return;
    let es: EventSourceLike;
    try {
      es = create(o.url(o.lastSeq()), { withCredentials: true });
    } catch {
      return fail();
    }
    source = es;
    const mine = (fn: (e: MessageEvent) => void) => (e: MessageEvent) => {
      if (source === es) fn(e);
    };
    es.addEventListener(
      'open',
      mine(() => {
        attempt = 0;
      }),
    );
    es.addEventListener(
      'message',
      mine((e) => {
        let data: unknown;
        try {
          data = JSON.parse(String(e.data));
        } catch {
          return;
        }
        const m = parseChatMessage(data);
        if (m) o.onMessage(m);
      }),
    );
    es.addEventListener(
      'resync',
      mine(() => o.onResync()),
    );
    es.addEventListener('close', mine(fail));
    es.addEventListener('error', mine(fail));
  };

  function fail() {
    close();
    if (!running || paused) return;
    const delay = Math.min(max, base * 2 ** attempt) * (1 + 0.2 * random());
    attempt += 1;
    clearTimeout(retry);
    retry = setTimeout(open, delay);
  }

  const onVisibility = () => {
    if (!running) return;
    if (visible()) {
      clearTimeout(hiddenTimer);
      hiddenTimer = undefined;
      if (paused) {
        paused = false;
        attempt = 0;
        open();
      }
    } else if (!hiddenTimer && !paused) {
      hiddenTimer = setTimeout(() => {
        hiddenTimer = undefined;
        paused = true;
        clearTimeout(retry);
        close();
      }, hiddenCloseMs);
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      events?.addEventListener('visibilitychange', onVisibility);
      open();
    },
    stop() {
      running = false;
      paused = false;
      clearTimeout(retry);
      clearTimeout(hiddenTimer);
      hiddenTimer = undefined;
      events?.removeEventListener('visibilitychange', onVisibility);
      close();
    },
  };
}
