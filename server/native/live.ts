import type { NativeEvent } from './types.js';
import { clip } from './text.js';

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
  /** The reply stopped being produced. How it ended (finished, stopped, failed) is the transcript's to say. */
  | { kind: 'done'; messageId: string; catId: string };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;

/**
 * What a step works on, in a form fit for a chat line. Only fields whose
 * meaning is known for that tool are read: a file tool gives a file name, a
 * fetch its host, a search its query, a delegation its title. A command line
 * is never passed on, and neither is text that carries an absolute path.
 */
function stepTarget(tool: string, input: unknown): string | undefined {
  const fields = record(input), name = tool.toLowerCase();
  const line = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const flat = value.trim().replace(/\s+/g, ' ');
    return /(?:^|[\s"'`(=:])(?:~|\/|[A-Za-z]:\\)[^\s]*[\\/]/.test(flat) ? undefined : clip(flat, 40);
  };
  if (/^(read|write|edit|multiedit|notebookedit|notebookread)$/.test(name)) {
    for (const key of ['file_path', 'notebook_path', 'path', 'filePath']) {
      const value = fields[key];
      if (typeof value === 'string' && value.trim()) {
        const file = value.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop();
        if (file) return clip(file, 60);
      }
    }
    return undefined;
  }
  // Codex reports a file edit as `file_change` with the files it touched.
  if (name === 'file_change' && Array.isArray(fields.changes)) {
    const first = record(fields.changes[0]).path;
    const file = typeof first === 'string' ? first.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() : undefined;
    return file ? clip(file, 60) : undefined;
  }
  if (/^(webfetch|web_fetch)$/.test(name)) {
    try { return typeof fields.url === 'string' ? clip(new URL(fields.url).hostname, 60) : undefined; } catch { return undefined; }
  }
  if (/^(websearch|web_search)$/.test(name)) return line(fields.query);
  if (/^(grep|glob)$/.test(name)) return line(fields.pattern);
  if (/^(task|agent)$/.test(name)) return line(fields.description);
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
      const target = stepTarget(tool, event.toolInput);
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
    // Codex has no thinking marker of its own kind; its transient status says the same.
    case 'status': return messageId && event.content === 'thinking' ? { kind: 'thinking', messageId, catId } : null;
    // Native ends a cat's turn with `done` or with an error that is not marked transient.
    // Neither says the reply succeeded: a `done` also follows a stop or a failure.
    case 'done': return messageId ? { kind: 'done', messageId, catId } : null;
    case 'error': return messageId && event.errorDisposition !== 'transient' ? { kind: 'done', messageId, catId } : null;
    default: return null;
  }
}
