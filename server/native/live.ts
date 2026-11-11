import type { NativeEvent } from './types.js';

/**
 * Display-only projection of the native per-turn events the engine already
 * emits on a thread room (text deltas, tool calls, thinking, start, finish).
 * It lets the chat draw a reply while it is being written. Nothing is stored
 * or replayed here: a client that missed part of a turn reads the persisted
 * native draft from the transcript, and the finished reply always comes from
 * the transcript as well.
 */
export type LiveEvent =
  | { kind: 'start'; messageId: string; catId: string }
  | { kind: 'thinking'; messageId: string; catId: string }
  | { kind: 'step'; messageId: string; catId: string; tool: string; target?: string }
  /** `end` is the native length (UTF-16 units) of the whole reply after this piece. */
  | { kind: 'text'; messageId: string; catId: string; text: string; end?: number; replace?: true }
  | { kind: 'done'; messageId: string; catId: string; ok: boolean };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
const clip = (value: string, max: number) => value.length > max ? value.slice(0, max - 1) + '…' : value;

/** What a step works on, in a form fit for a chat line: a file name, a site, a short query. Never a command or a full path. */
function stepTarget(input: unknown): string | undefined {
  const fields = record(input);
  for (const key of ['file_path', 'path', 'notebook_path', 'filePath']) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim()) {
      const name = value.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      if (name) return clip(name, 60);
    }
  }
  if (typeof fields.url === 'string') {
    try { return clip(new URL(fields.url).hostname, 60); } catch { return undefined; }
  }
  for (const key of ['query', 'pattern', 'description']) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim()) return clip(value.trim().replace(/\s+/g, ' '), 40);
  }
  return undefined;
}

export function liveEvent(event: NativeEvent, threadId: string): LiveEvent | null {
  if (event.threadId !== threadId) return null;
  const catId = text(event.catId, 200);
  if (!catId) return null;
  const messageId = text(event.messageId, 200);
  switch (event.type) {
    case 'text': {
      const piece = typeof event.content === 'string' ? event.content : '';
      // Explicit posts and connector messages arrive whole; only the reply stream is drawn live.
      if (!messageId || !piece || event.origin !== 'stream') return null;
      const layout = record(record(event.extra).outputLayout), owner = record(layout.owner);
      const length = record(layout.contentRevision).length;
      const end = owner.threadId === threadId && owner.catId === catId && typeof length === 'number'
        && Number.isSafeInteger(length) && length >= piece.length ? length : undefined;
      return { kind: 'text', messageId, catId, text: piece, ...(end !== undefined ? { end } : {}),
        ...(event.textMode === 'replace' ? { replace: true as const } : {}) };
    }
    case 'tool_use': {
      const tool = text(event.toolName, 120);
      if (!messageId || !tool) return null;
      const target = stepTarget(event.toolInput);
      return { kind: 'step', messageId, catId, tool, ...(target ? { target } : {}) };
    }
    case 'system_info': {
      const content = text(event.content, 20_000);
      if (!content || content[0] !== '{') return null;
      let info: Record<string, unknown>;
      try { info = record(JSON.parse(content)); } catch { return null; }
      if (info.type === 'thinking') return messageId ? { kind: 'thinking', messageId, catId } : null;
      if (info.type === 'invocation_created') {
        const reply = text(event.lifecycleResponseMessageId, 200) ?? messageId;
        return reply ? { kind: 'start', messageId: reply, catId } : null;
      }
      return null;
    }
    case 'done': return messageId ? { kind: 'done', messageId, catId, ok: true } : null;
    case 'error': return messageId ? { kind: 'done', messageId, catId, ok: false } : null;
    default: return null;
  }
}
