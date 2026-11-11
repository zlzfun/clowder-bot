import { createHash } from 'node:crypto';
import type { NativeMessage } from './types.js';

/**
 * The member check's refusals (patches/0001) as a chat can say them. The
 * engine records each one in the thread as a system line with internal ids
 * ("Error: Member bot-… is not in the execution roster of thread …"); a
 * mention that reaches cats outside the conversation (the engine's @all means
 * every cat the owner has) leaves one per cat. Refusals that follow the same
 * owner message are told once, by name: the first keeps the line, the others
 * are folded into it (null). Other messages are not in the map.
 */
export function rosterRefusals(messages: NativeMessage[], nameOf: (catId: string) => string | undefined, group: boolean): Map<string, string | null> {
  const told = new Map<string, string | null>();
  let first: string | undefined, names: string[] = [];
  for (const message of messages) {
    if (message.type === 'user') { first = undefined; names = []; continue; }
    const refused = message.type === 'system' ? /^Error: Member (\S+) is not in the execution roster of thread \S+$/.exec(message.content.trim())?.[1] : undefined;
    if (!refused) continue;
    const name = nameOf(refused) ?? '有只猫猫';
    if (!names.includes(name)) names.push(name);
    told.set(message.id, null);
    first ??= message.id;
    told.set(first, `${names.join('、')}不在这个${group ? '群' : '对话'}里，没有回答。`);
  }
  return told;
}

/**
 * The engine's receipt after the owner answered a request for confirmation: a
 * connector message from its approval hub that names the request, the card
 * message it belonged to and how it was resolved ("审批结果：品味提案 proposal_…
 * 已批准。" in the engine's words).
 */
export function approvalReceipt(message: NativeMessage): { proposalId: string; producerId: string; state: 'approved' | 'rejected' | 'closed'; cardMessageId?: string } | undefined {
  if (message.type !== 'connector') return undefined;
  const source = record(message.source), receipt = record(record(source.meta).approvalDecisionReceipt);
  if (source.connector !== 'approval-hub' || receipt.kind !== 'approval_decision_receipt' || typeof receipt.canonicalProposalId !== 'string') return undefined;
  const card = record(receipt.approvalCardRef).messageId;
  return { proposalId: receipt.canonicalProposalId, producerId: typeof receipt.producerId === 'string' ? receipt.producerId : '',
    state: receipt.resolution === 'accepted' ? 'approved' : receipt.resolution === 'rejected' ? 'rejected' : 'closed',
    ...(typeof card === 'string' ? { cardMessageId: card } : {}) };
}
/** That receipt in the chat's words. */
export function approvalReceiptText(receipt: NonNullable<ReturnType<typeof approvalReceipt>>): string {
  const said: Record<string, [string, string]> = {
    F221: ['已记住这个偏好。', '没有记这个偏好。'], F231: ['已更新关于你的资料。', '没有更新关于你的资料。'],
    F276: ['已记下这个人。', '没有记这个人。'], F139: ['定时已按你的确认处理。', '定时没有改动。'],
  };
  const [yes, no] = said[receipt.producerId] ?? ['已同意。', '已拒绝。'];
  return receipt.state === 'approved' ? yes : receipt.state === 'rejected' ? no : '这件事已经结束。';
}

/** A reply the engine is still producing: an unpublished draft or a response that has not settled. */
export function replyInProgress(message: NativeMessage): boolean {
  return message.type === 'assistant'
    && (message.isDraft === true || ['queued', 'processing'].includes(message.lifecycle?.status ?? ''));
}

/**
 * How a reply that did not finish normally ended, from the native response
 * lifecycle: stopped by the owner, failed (with native's own reason when it
 * gave one, for an optional details view) or interrupted. Undefined for a
 * reply that completed or is still being written.
 */
export function replyEnding(message: NativeMessage): { how: 'stopped' | 'failed' | 'interrupted'; reason?: string } | undefined {
  if (message.type !== 'assistant') return undefined;
  const status = message.lifecycle?.status, reason = message.lifecycle?.reason;
  const how = status === 'failed' ? 'failed' : status === 'interrupted' ? 'interrupted' : status === 'canceled' || status === 'cancelled' ? 'stopped' : undefined;
  if (!how) return undefined;
  return { how, ...(how !== 'stopped' && typeof reason === 'string' && reason.trim() ? { reason: reason.trim().slice(0, 2000) } : {}) };
}

/**
 * Display-only text, shared by direct and group chats. Native records stay
 * untouched. A reply still in progress has whatever was written so far, which
 * may be nothing: the row then carries `in_progress` and the chat draws a
 * typing indicator instead of placeholder words.
 */
export function messageDisplayText(message: NativeMessage, threadId: string, catName?: string): string {
  const text = message.type === 'assistant' ? withoutLeadingSignature(withoutCatSignature(message, threadId), catName) : message.content;
  const content = message.type === 'assistant' && text.trim() === 'SILENT' ? '' : text;
  if (content || replyInProgress(message)) return content;
  if (['canceled', 'cancelled'].includes(message.lifecycle?.status ?? '')) return '已停止';
  if (message.lifecycle?.status === 'interrupted') return '中途被打断，没有写完';
  return message.lifecycle?.status === 'failed' ? '这次没完成，请查看详情' : '';
}

/**
 * Some models open a reply with the paw signature instead of closing with it
 * ("[快手/Haiku🐾]  今天…", seen in real group replies). It is hidden only when
 * it is the speaking cat's own name and words follow it (on the same line or,
 * as in "[快手/Haiku🐾]\n\n7", on the next), so a reply that quotes another
 * cat's signature, or mentions one further inside, keeps its text.
 */
function withoutLeadingSignature(text: string, catName?: string): string {
  if (!catName || !text.startsWith('[')) return text;
  const match = /^\[([^\[\]\r\n/]{1,80})(?:\/[^\[\]\r\n]{0,80})?\s?🐾\]\s+(?=\S)/u.exec(text);
  return match && match[1]!.trim() === catName ? text.slice(match[0].length) : text;
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
    // A cat may also sign by itself just before the host tail; that line goes too.
    return valid ? withoutStandaloneSignature(text.slice(0, start as number)) : text;
  }
  return withoutStandaloneSignature(text);
}

// Older records and provider-written signatures have no host range. Only a
// standalone final paw signature is hidden, outside Markdown code fences.
function withoutStandaloneSignature(text: string): string {
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
