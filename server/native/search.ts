import type { BotBridge } from './bridge.js';
import { messageDisplayText } from './message-presentation.js';
import { plainLine } from './text.js';
import { requestLine } from './blocks.js';
import type { NativeCat, NativeMessage } from './types.js';

export interface SearchHit {
  chat: { type: 'bot' | 'group'; id: string; name: string };
  threadId: string;
  /** False for an earlier conversation of a cat, which has to be opened from its history first. */
  current: boolean;
  messageId: string; time: string; from: 'owner' | 'cat'; catName?: string;
  snippet: string; match: [number, number];
}
const orderTime = (message: NativeMessage) => message.timelineOrderAt ?? message.timestamp;

/**
 * The words around the first match, on one line, with where the match sits in
 * them. A cat's reply (`markdown`) is searched as the words it shows, without
 * its Markdown marks; a phrase that only matches with the marks (someone
 * looking for "`npm ci`") is still found in the text as written.
 */
export function snippet(text: string, query: string, markdown = false): { snippet: string; match: [number, number] } | null {
  const written = text.replace(/\s+/g, ' ').trim(), wanted = query.toLowerCase();
  const shown = markdown ? plainLine(text) : written;
  const line = shown.toLowerCase().includes(wanted) ? shown : written, at = line.toLowerCase().indexOf(wanted);
  if (at < 0) return null;
  const from = Math.max(0, at - 24), to = Math.min(line.length, at + query.length + 72);
  const head = from > 0 ? '…' : '';
  return { snippet: head + line.slice(from, to) + (to < line.length ? '…' : ''), match: [head.length + at - from, head.length + at - from + query.length] };
}

/**
 * Find a phrase in what was said: a read of the newest native message page of
 * each of the owner's conversations at the moment of the search, filtered the
 * way the chat shows them. No index and no copy is kept. Conversations that
 * could not be read are counted, never silently skipped.
 */
export async function searchMessages(bridge: BotBridge, query: string, limit = 30, only?: { chat: SearchHit['chat']; threadId: string }) {
  const { store } = bridge, cats = await bridge.cats();
  const targets: Array<{ chat: SearchHit['chat']; threadId: string; current: boolean }> = [];
  const seen = new Set<string>();
  const add = (chat: SearchHit['chat'], threadId: string | undefined, current: boolean) => {
    if (!threadId || seen.has(threadId)) return;
    seen.add(threadId); targets.push({ chat, threadId, current });
  };
  // Within one chat: only the conversation that is open in it, so its matches are not crowded out by other chats.
  if (only) add(only.chat, only.threadId, true);
  else {
    for (const cat of cats) {
      const meta = store.bot(cat.id), chat = { type: 'bot' as const, id: cat.id, name: cat.name };
      add(chat, meta.activeThreadId, true);
      for (const id of meta.conversationIds ?? []) add(chat, id, false);
    }
    for (const id of store.state.groupThreadIds) add({ type: 'group', id, name: '' }, id, true);
  }
  const capped = targets.slice(0, 80);
  let failed = 0, more = targets.length > capped.length;
  const hits: Array<SearchHit & { order: number }> = [];
  await Promise.all(capped.map(async target => {
    try {
      const [thread, page] = await Promise.all([target.chat.type === 'group' ? bridge.thread(target.threadId) : undefined, bridge.messages(target.threadId)]);
      const chat = thread ? { ...target.chat, name: thread.title ?? '群聊' } : target.chat;
      if (page.hasMore) more = true;
      const replies = new Set(bridge.activity.visibleReplies(target.threadId, page.messages, cats).map(message => message.id));
      for (const message of page.messages) {
        // The opening invitation the app sent for the owner is not something the owner said.
        const owner = message.type === 'user' && !bridge.isInvitation(target.threadId, message);
        if (!owner && !replies.has(message.id)) continue;
        const cat: NativeCat | undefined = owner ? undefined : cats.find(known => known.id === message.catId);
        const found = snippet(requestLine(message) ?? messageDisplayText(message, target.threadId, cat?.name), query, !owner);
        if (!found) continue;
        hits.push({ chat, threadId: target.threadId, current: target.current, messageId: message.id, time: new Date(message.timestamp).toISOString(),
          from: owner ? 'owner' : 'cat', ...(cat ? { catName: cat.name } : {}), ...found, order: orderTime(message) });
      }
    } catch { failed++; }
  }));
  hits.sort((a, b) => b.order - a.order || (a.messageId < b.messageId ? 1 : -1));
  return {
    query, results: hits.slice(0, limit).map(({ order, ...hit }) => hit),
    // `more`: there were more matches than returned, or older messages that were not looked at.
    more: more || hits.length > limit, searched: capped.length - failed, failed,
  };
}
