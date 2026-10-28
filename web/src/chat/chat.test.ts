import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, json, on } from '../test/fakeFetch';
import { RateLimitedError } from '../domain/comments';
import { chatBodyProblem, createHttpChatGateway, type ChatMessage } from './http';
import { createChatStream, type EventSourceLike } from './stream';
import { incoming, mergeMessages, newestSeq } from './model';

const API = 'https://api.example';

const wire = (seq: number, mine = false, body = `m${seq}`) => ({
  id: `msg${String(seq).padStart(12, '0')}`,
  repo_id: 9,
  seq,
  author: { kind: 'human', login: mine ? 'ana' : 'bo' },
  mine,
  body,
  created_at: '2026-10-28T10:00:00.000Z',
});
const msg = (seq: number, mine = false): ChatMessage => ({
  id: `msg${String(seq).padStart(12, '0')}`,
  seq,
  author: { kind: 'human', login: mine ? 'ana' : 'bo' },
  mine,
  body: `m${seq}`,
  createdAt: '2026-10-28T10:00:00.000Z',
});

describe('chat gateway', () => {
  it('sends the documented request shapes', async () => {
    const f = fakeFetch([
      on('GET', `${API}/api/galley/repos/9/chat`, () => json({ messages: [wire(1), wire(2, true), { seq: 'x' }], has_more: true })),
      on('GET', `${API}/api/galley/repos/9/chat?before_seq=1&limit=50`, () => json({ messages: [], has_more: false })),
      on('POST', `${API}/api/galley/repos/9/chat`, () => json(wire(3, true, 'hello'), 201)),
      on('POST', `${API}/api/galley/repos/9/chat/read`, () => json({ last_read_seq: 3 })),
      on('GET', `${API}/api/galley/repos/9/chat/unread`, () => json({ repo_id: 9, unread: 4, last_read_seq: 1, latest_seq: 5 })),
    ]);
    const g = createHttpChatGateway({ apiBase: API, fetch: f.fetch });
    expect(await g.history(9)).toEqual({ messages: [msg(1), msg(2, true)], hasMore: true });
    expect(await g.history(9, 1)).toEqual({ messages: [], hasMore: false });
    expect((await g.post(9, 'hello')).body).toBe('hello');
    expect(await g.markRead(9, 3)).toBe(3);
    expect(await g.unread(9)).toEqual({ unread: 4, lastReadSeq: 1, latestSeq: 5 });
    expect(g.streamUrl(9, 5)).toBe(`${API}/api/galley/repos/9/chat/stream?last_event_id=5`);
    expect(g.streamUrl(9, 0)).toBe(`${API}/api/galley/repos/9/chat/stream`);

    const post = f.requests.find((r) => r.method === 'POST' && r.url.endsWith('/chat'));
    expect(post?.body).toEqual({ body: 'hello' });
    expect(post?.headers.get('X-Galley-CSRF')).toBe('1');
    expect(post?.headers.get('Content-Type')).toBe('application/json');
    expect(f.requests.find((r) => r.url.endsWith('/read'))?.body).toEqual({ seq: 3 });
    expect(f.requests.every((r) => r.credentials === 'include')).toBe(true);
  });

  it('maps 429 with Retry-After', async () => {
    const f = fakeFetch([on('POST', `${API}/api/galley/repos/9/chat`, () => json({ error: 'Too Many Requests' }, 429, { 'Retry-After': '3' }))]);
    const g = createHttpChatGateway({ apiBase: API, fetch: f.fetch });
    const err = await g.post(9, 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterSeconds).toBe(3);
  });

  it('checks the composer limits: non-blank, 4 KB of UTF-8, no NUL or bidi controls', () => {
    expect(chatBodyProblem('  \n ')).toBe('blank');
    expect(chatBodyProblem('a'.repeat(4096))).toBeUndefined();
    expect(chatBodyProblem('a'.repeat(4097))).toBe('too-long');
    expect(chatBodyProblem('é'.repeat(2049))).toBe('too-long');
    expect(chatBodyProblem('a\u0000b')).toBe('invalid');
    expect(chatBodyProblem('a‮b')).toBe('invalid');
    expect(chatBodyProblem('hi')).toBeUndefined();
  });
});

describe('chat model', () => {
  it('merges by seq without duplicates, oldest first', () => {
    expect(mergeMessages([msg(2), msg(3)], [msg(3), msg(1), msg(4)]).map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(newestSeq([msg(2), msg(7)])).toBe(7);
    expect(newestSeq([])).toBe(0);
  });

  it('unread badge: messages by others count while the chat is not being read; read when visible', () => {
    expect(incoming({ unread: 0 }, msg(5), false)).toEqual({ unread: 1 });
    expect(incoming({ unread: 2 }, msg(5, true), false)).toEqual({ unread: 2 });
    expect(incoming({ unread: 2 }, msg(6), true)).toEqual({ unread: 0, markRead: 6 });
  });
});

class FakeEventSource implements EventSourceLike {
  static all: FakeEventSource[] = [];
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  closed = false;
  constructor(
    readonly url: string,
    readonly init: { withCredentials: boolean },
  ) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data = '', lastEventId = '') {
    for (const fn of this.listeners[type] ?? []) fn({ data, lastEventId } as MessageEvent);
  }
}
const latest = () => FakeEventSource.all.at(-1) as FakeEventSource;

describe('chat stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.all = [];
  });
  afterEach(() => vi.useRealTimers());

  const setup = (lastSeq = 5) => {
    const events = new EventTarget();
    let hidden = false;
    let seq = lastSeq;
    const got: ChatMessage[] = [];
    const resyncs: number[] = [];
    const stream = createChatStream({
      url: (s) => `${API}/stream${s ? `?last_event_id=${s}` : ''}`,
      lastSeq: () => seq,
      create: (url, init) => new FakeEventSource(url, init),
      onMessage: (m) => {
        got.push(m);
        seq = Math.max(seq, m.seq);
      },
      onResync: () => resyncs.push(1),
      visible: () => !hidden,
      events,
      hiddenCloseMs: 60_000,
      random: () => 0,
    });
    const hide = (v: boolean) => {
      hidden = v;
      events.dispatchEvent(new Event('visibilitychange'));
    };
    return { stream, got, resyncs, hide };
  };

  it('opens with credentials and the newest seq, delivers messages and ignores junk', () => {
    const { stream, got } = setup();
    stream.start();
    expect(latest().url).toBe(`${API}/stream?last_event_id=5`);
    expect(latest().init).toEqual({ withCredentials: true });
    latest().emit('open');
    latest().emit('message', JSON.stringify(wire(6)), '6');
    latest().emit('message', '{not json');
    latest().emit('message', JSON.stringify({ seq: 7 }));
    expect(got.map((m) => m.seq)).toEqual([6]);
    stream.stop();
    expect(latest().closed).toBe(true);
  });

  it('resync asks for a history reload', () => {
    const { stream, resyncs } = setup();
    stream.start();
    latest().emit('resync', '{}');
    expect(resyncs).toHaveLength(1);
    stream.stop();
  });

  it('reconnects with exponential backoff from the newest seq, and resets after a good connection', async () => {
    const { stream } = setup();
    stream.start();
    const first = latest();
    first.emit('message', JSON.stringify(wire(8)), '8');
    first.emit('error');
    expect(first.closed).toBe(true);
    expect(FakeEventSource.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeEventSource.all).toHaveLength(2);
    expect(latest().url).toBe(`${API}/stream?last_event_id=8`);
    latest().emit('error');
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeEventSource.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.all).toHaveLength(3);
    latest().emit('open');
    latest().emit('close', '{}'); // the server ended it (session gone): reconnect, backoff reset
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeEventSource.all).toHaveLength(4);
    stream.stop();
    latest().emit('error');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeEventSource.all).toHaveLength(4);
  });

  it('caps the backoff at a minute', async () => {
    const { stream } = setup();
    stream.start();
    for (let i = 0; i < 10; i++) {
      latest().emit('error');
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(FakeEventSource.all).toHaveLength(11);
    stream.stop();
  });

  it('closes after the tab stays hidden, and reopens when it is shown again', async () => {
    const { stream, hide } = setup();
    stream.start();
    hide(true);
    await vi.advanceTimersByTimeAsync(30_000);
    hide(false);
    hide(true);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(latest().closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(latest().closed).toBe(true);
    expect(FakeEventSource.all).toHaveLength(1);
    hide(false);
    expect(FakeEventSource.all).toHaveLength(2);
    expect(latest().closed).toBe(false);
    stream.stop();
  });
});
