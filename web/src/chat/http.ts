import { GatewayError } from '../domain';
import { checkRepo, createGalleyApi, isRecord, str, type GalleyApiOptions } from '../galley/api';

// The chat API (README, "Chat API"): one chat per paper with history, read
// markers and a Server-Sent Events stream. Message bodies are untrusted and
// shown as plain text only.

export interface ChatMessage {
  id: string;
  seq: number;
  author: { kind: 'human' | 'ai'; login: string };
  mine: boolean;
  body: string;
  createdAt: string;
}

export interface ChatPage {
  messages: ChatMessage[];
  hasMore: boolean;
}

export interface ChatUnread {
  unread: number;
  lastReadSeq: number;
  latestSeq: number;
}

export interface ChatGateway {
  /** Oldest first; without `beforeSeq` the newest page. */
  history(repoId: number, beforeSeq?: number): Promise<ChatPage>;
  post(repoId: number, body: string): Promise<ChatMessage>;
  /** Moves the read marker to `seq` (never back); returns the marker. */
  markRead(repoId: number, seq?: number): Promise<number>;
  unread(repoId: number): Promise<ChatUnread>;
  /** The stream URL; `lastEventId` replays what came after it (EventSource cannot send the header on its first request). */
  streamUrl(repoId: number, lastEventId: number): string;
}

export const MAX_CHAT_BYTES = 4096;
export const PAGE_SIZE = 50;

const seqOk = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const count = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);

export function parseChatMessage(v: unknown): ChatMessage | undefined {
  if (!isRecord(v) || !str(v.id) || !seqOk(v.seq) || !str(v.body) || !str(v.created_at)) return undefined;
  const a = v.author;
  if (!isRecord(a) || (a.kind !== 'human' && a.kind !== 'ai') || !str(a.login)) return undefined;
  return { id: v.id, seq: v.seq, author: { kind: a.kind, login: a.login }, mine: v.mine === true, body: v.body, createdAt: v.created_at };
}

// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000‪-‮⁦-⁩]/;

/** Why the composer cannot send `body`, or undefined when it can. */
export function chatBodyProblem(body: string): 'blank' | 'too-long' | 'invalid' | undefined {
  if (!body.trim()) return 'blank';
  if (new TextEncoder().encode(body).length > MAX_CHAT_BYTES) return 'too-long';
  if (FORBIDDEN.test(body)) return 'invalid';
  return undefined;
}

export function createHttpChatGateway(options: GalleyApiOptions = {}): ChatGateway {
  const api = createGalleyApi('chat', options);
  const at = (repoId: number, rest = '') => `/repos/${checkRepo(repoId)}/chat${rest}`;
  const message = (v: unknown): ChatMessage => {
    const m = parseChatMessage(v);
    if (!m) throw new GatewayError('malformed chat message');
    return m;
  };
  return {
    async history(repoId, beforeSeq) {
      const qs = beforeSeq ? `?before_seq=${beforeSeq}&limit=${PAGE_SIZE}` : '';
      const { data } = await api.send('GET', at(repoId, qs));
      if (!isRecord(data) || !Array.isArray(data.messages)) throw new GatewayError('malformed chat history');
      return {
        messages: data.messages.map(parseChatMessage).filter((m): m is ChatMessage => m !== undefined),
        hasMore: data.has_more === true,
      };
    },
    async post(repoId, body) {
      return message((await api.send('POST', at(repoId), { body: { body } })).data);
    },
    async markRead(repoId, seq) {
      const { data } = await api.send('POST', at(repoId, '/read'), { body: seq === undefined ? {} : { seq } });
      return isRecord(data) ? count(data.last_read_seq) : 0;
    },
    async unread(repoId) {
      const { data } = await api.send('GET', at(repoId, '/unread'));
      if (!isRecord(data)) throw new GatewayError('malformed chat unread');
      return { unread: count(data.unread), lastReadSeq: count(data.last_read_seq), latestSeq: count(data.latest_seq) };
    },
    streamUrl(repoId, lastEventId) {
      return `${api.base}${at(repoId, '/stream')}${lastEventId > 0 ? `?last_event_id=${lastEventId}` : ''}`;
    },
  };
}
