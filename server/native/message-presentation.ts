import { createHash } from 'node:crypto';
import type { NativeMessage } from './types.js';

/** Display-only fallback, shared by direct and group chats. Native records stay untouched. */
export function messageDisplayText(message: NativeMessage, threadId: string): string {
  const text = message.type === 'assistant' ? withoutCatSignature(message, threadId) : message.content;
  const content = message.type === 'assistant' && text.trim() === 'SILENT' ? '' : text;
  if (content) return content;
  if (message.isDraft || ['queued', 'processing'].includes(message.lifecycle?.status ?? '')) return '正在等待或处理…';
  if (['canceled', 'cancelled'].includes(message.lifecycle?.status ?? '')) return '已停止';
  return message.lifecycle?.status === 'failed' ? '这次没完成，请查看详情' : '';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The pinned native outputLayout identifies the host-produced answer suffix. */
function withoutCatSignature(message: NativeMessage, threadId: string): string {
  const text = message.content, layout = record(message.extra?.outputLayout);
  const tail = record(layout.hostTail), owner = record(layout.owner), revision = record(layout.contentRevision);
  if (layout.hostTail !== undefined) {
    const start = tail.start;
    const valid = layout.v === 1 && layout.status === 'available' && message.origin === 'stream'
      && !message.extra?.isExplicitPost && owner.threadId === threadId && owner.catId === message.catId
      && typeof owner.turnInvocationId === 'string' && turnKey(message) === JSON.stringify([message.catId, owner.turnInvocationId])
      && tail.kind === 'cat_signature' && tail.producer === 'codex_stream_finalizer'
      && ['runtime_canonical', 'provider_observed_fallback'].includes(String(tail.basis))
      && typeof start === 'number' && Number.isSafeInteger(start) && start >= 0 && start + 2 < text.length && tail.end === text.length
      && tail.gluePrefixLength === 2 && text.slice(start, start + 2) === '\n\n'
      && revision.length === text.length && revision.sha256 === createHash('sha256').update(text).digest('hex');
    return valid ? text.slice(0, start) : text;
  }

  // Older records and provider-written signatures have no host range. Only a
  // standalone final paw signature is hidden, outside Markdown code fences.
  const signature = /(?:^|\r?\n)(?: {0,3}\[[^\[\]\r\n]+🐾\][ \t]*(?:\r?\n|$))+\s*$/u.exec(text);
  if (!signature) return text;
  let fence = '';
  for (const line of text.slice(0, signature.index).split(/\r?\n/)) {
    const match = /^[ \t>]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const marker = match[1]!;
    if (!fence) {
      if (marker[0] !== '`' || !match[2]!.includes('`')) fence = marker;
    } else if (marker[0] === fence[0] && marker.length >= fence.length && !match[2]!.trim()) fence = '';
  }
  return fence ? text : text.slice(0, signature.index).trimEnd();
}

/** Only exact native turn identity may join a stream to its explicit chat posts. */
function turnKey(message: NativeMessage): string | undefined {
  if (!message.catId) return;
  const identities = [
    message.lifecycle?.kind === 'response' ? message.lifecycle.invocationId : undefined,
    record(message.extra?.turnExecution).invocationId,
    record(message.extra?.stream).turnInvocationId,
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);
  const unique = [...new Set(identities)];
  // The outer stream.invocationId can be shared by several cats: never use it.
  if (unique.length !== 1) return;
  return JSON.stringify([message.catId, unique[0]]);
}

/** Read-only view classification; original content, IDs and times are never rewritten. */
export function messagePresentation(messages: NativeMessage[]): Map<string, 'message' | 'activity'> {
  const explicitTurns = new Set(messages.filter(m => m.type === 'assistant' && m.origin === 'callback'
    && m.extra?.isExplicitPost === true).map(turnKey).filter((key): key is string => !!key));
  return new Map(messages.map(message => {
    const key = turnKey(message);
    const failed = ['failed', 'canceled', 'cancelled'].includes(message.lifecycle?.status ?? '');
    const activity = message.type === 'assistant' && message.origin === 'stream' && !failed
      && key !== undefined && explicitTurns.has(key);
    return [message.id, activity ? 'activity' : 'message'];
  }));
}
