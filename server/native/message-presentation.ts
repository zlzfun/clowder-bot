import type { NativeMessage } from './types.js';

/** Display-only fallback, shared by direct and group chats. Native records stay untouched. */
export function messageDisplayText(message: NativeMessage): string {
  const content = message.type === 'assistant' && message.content.trim() === 'SILENT' ? '' : message.content;
  if (content) return content;
  if (message.isDraft || ['queued', 'processing'].includes(message.lifecycle?.status ?? '')) return '正在等待或处理…';
  if (['canceled', 'cancelled'].includes(message.lifecycle?.status ?? '')) return '已停止';
  return message.lifecycle?.status === 'failed' ? '这次没完成，请查看详情' : '';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
