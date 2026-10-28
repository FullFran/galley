import type { ChatMessage } from './http';

/** One list, oldest first, without duplicates (by seq). */
export function mergeMessages(a: ChatMessage[], b: ChatMessage[]): ChatMessage[] {
  const bySeq = new Map<number, ChatMessage>();
  for (const m of a) bySeq.set(m.seq, m);
  for (const m of b) bySeq.set(m.seq, m);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

export function newestSeq(list: ChatMessage[]): number {
  return list.reduce((n, m) => Math.max(n, m.seq), 0);
}

/**
 * A new message arrived. While the chat is being read (panel open, tab
 * visible) it is marked read at once; otherwise other people's messages add
 * to the unread badge.
 */
export function incoming(state: { unread: number }, m: ChatMessage, viewing: boolean): { unread: number; markRead?: number } {
  if (viewing) return { unread: 0, markRead: m.seq };
  return { unread: m.mine ? state.unread : state.unread + 1 };
}
