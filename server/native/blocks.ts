import type { NativeMessage } from './types.js';
import { clip, plainLine } from './text.js';
import { triggerWords } from './trigger-words.js';

/**
 * What a cat attached to a message besides words and files, as the chat can
 * draw it: the native rich blocks (`extra.rich`, written by the engine's
 * create-rich-block tool) reduced to the fields a chat shows. Files are
 * projected separately (files.ts). Kinds the chat cannot show yet are counted
 * so the message can say something is missing instead of dropping it silently.
 */
export type ChatBlock =
  | { id: string; kind: 'card'; title: string; body?: string; tone?: 'info' | 'success' | 'warning' | 'danger'; fields?: Array<{ label: string; value: string }>;
      /**
       * Set when the card is a native request for the owner's confirmation (see approvals.ts): what it
       * asks for in the chat's words, read from the card itself so it can still be said once the request
       * is settled (`title` has no subject: "想设一个定时"); `state` once the engine's receipt on the
       * same page says how it was answered.
       */
      approval?: { id: string; kind: RequestKind; title: string; body?: string; state?: 'approved' | 'rejected' | 'closed' } }
  | { id: string; kind: 'checklist'; title?: string; items: Array<{ id: string; text: string; checked: boolean }> }
  | { id: string; kind: 'choices'; mode: 'single' | 'multiple' | 'confirm'; title?: string; description?: string;
      options: Array<{ id: string; label: string; emoji?: string; description?: string; custom?: true }>;
      max?: number; template?: string; answered: boolean; selected: string[] }
  | { id: string; kind: 'diff'; file: string; diff: string };

export type RequestKind = 'preference' | 'profile' | 'person' | 'schedule' | 'question' | 'other';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim() ? clip(value, max) : undefined;
const tones = ['info', 'success', 'warning', 'danger'] as const;

/**
 * What a native request card asks for, in the chat's words. The engine writes these cards for its own
 * web client ("提议创建定时任务：每周五写周报", a Trigger field holding JSON, "提议捕捉品味信号");
 * the producer says which kind it is, the card's own title, body and fields say the rest.
 */
function requestWords(producer: unknown, block: Record<string, unknown>): { kind: RequestKind; title: string; body?: string } {
  const heading = text(block.title, 300) ?? '', colon = heading.search(/[：:]/);
  const label = colon >= 0 ? clip(heading.slice(colon + 1).trim(), 80) : '';
  // The card's first paragraph is what it is about; the engine labels it in bold ("**猫的判断（假设）：** …")
  // and follows it with context written for its own client (场景, the quoted words).
  const first = (typeof block.bodyMarkdown === 'string' ? block.bodyMarkdown : '').trim().split(/\n\s*\n/)[0] ?? '';
  const said = plainLine(first.replace(/^\*\*[^*\n]{1,40}[：:]\*\*\s*/, ''));
  const body = (value: string) => value ? { body: clip(value, 400) } : {};
  switch (producer) {
    case 'F139': {
      const field = (Array.isArray(block.fields) ? block.fields : []).map(record).find(entry => entry.label === 'Trigger');
      let when = '';
      try { when = typeof field?.value === 'string' ? triggerWords(JSON.parse(field.value)) : ''; } catch { /* not a trigger the card spells out */ }
      const verb = colon >= 0 ? heading.slice(0, colon) : heading, remove = /删除|取消|移除|停用/.test(verb), change = /更新|修改/.test(verb);
      return { kind: 'schedule', title: remove ? '想取消一个定时' : change ? '想改一个定时' : '想设一个定时', ...body([label, when].filter(Boolean).join(' · ')) };
    }
    case 'F221': return { kind: 'preference', title: '想记住你的一个偏好', ...body(said) };
    case 'F231': return { kind: 'profile', title: '想更新关于你的资料', ...body(said) };
    case 'F276': return { kind: 'person', title: '想记下一位相关的人', ...body(said) };
    case 'F306': return { kind: 'question', title: '有件事要问你', ...body(said || label || heading) };
    default: return { kind: 'other', title: '有件事等你确认', ...body(label || heading) };
  }
}

/** How the engine's receipt says a request for confirmation was answered (see message-presentation.ts approvalReceipt). */
export interface ApprovalDecision { proposalId: string; producerId: string; state: 'approved' | 'rejected' | 'closed'; cardMessageId?: string }

/**
 * `decided`: the receipts on the same page. A request card takes its state only
 * from a receipt for the same request by the same producer and, when the
 * receipt names the card's message, for this message.
 */
const answers = (receipt: ApprovalDecision, proposal: string, producerId: unknown, messageId: string) =>
  receipt.proposalId === proposal && receipt.producerId === producerId && (receipt.cardMessageId === undefined || receipt.cardMessageId === messageId);
/**
 * The receipts, among `decided`, that this message's request cards take their state from (the same rule and the same
 * cards as messageBlocks). Such a card says how it was answered, so the receipt need not be said again as a line.
 */
export function cardReceipts(message: NativeMessage, decided: ApprovalDecision[]): ApprovalDecision[] {
  const raw = record(message.extra?.rich).blocks, used: ApprovalDecision[] = [];
  for (const entry of Array.isArray(raw) ? raw.slice(0, 50) : []) {
    const block = record(entry);
    if (!text(block.id, 200) || block.kind !== 'card' || !text(block.title, 300)) continue;
    const approval = record(record(block.meta).approval), proposal = text(approval.canonicalProposalId, 200);
    const receipt = proposal ? decided.find(item => answers(item, proposal, approval.producerId, message.id)) : undefined;
    if (receipt) used.push(receipt);
  }
  return used;
}
export function messageBlocks(message: NativeMessage, decided: ApprovalDecision[] = []): { blocks: ChatBlock[]; hidden: number } {
  const raw = record(message.extra?.rich).blocks, blocks: ChatBlock[] = [];
  let hidden = 0;
  for (const entry of Array.isArray(raw) ? raw.slice(0, 50) : []) {
    const block = record(entry), id = text(block.id, 200);
    if (!id) { hidden++; continue; }
    if (block.kind === 'file') continue;
    // The summary card of one remember call only refers to other cards and receipts; the line it becomes is said by engineNote.
    if (block.kind === 'card' && record(block.meta).kind === 'memory_group') continue;
    if (block.kind === 'card' && text(block.title, 300)) {
      const approval = record(record(block.meta).approval), proposal = text(approval.canonicalProposalId, 200);
      const state = proposal ? decided.find(receipt => answers(receipt, proposal, approval.producerId, message.id))?.state : undefined;
      const fields = (Array.isArray(block.fields) ? block.fields : []).map(record)
        .filter(field => typeof field.label === 'string' && typeof field.value === 'string').slice(0, 20)
        .map(field => ({ label: clip(field.label as string, 80), value: clip(field.value as string, 400) }));
      blocks.push({ id, kind: 'card', title: text(block.title, 300)!, ...(text(block.bodyMarkdown, 8000) ? { body: text(block.bodyMarkdown, 8000)! } : {}),
        ...(tones.includes(block.tone as never) ? { tone: block.tone as typeof tones[number] } : {}), ...(fields.length ? { fields } : {}),
        ...(proposal ? { approval: { id: proposal, ...requestWords(approval.producerId, block), ...(state ? { state } : {}) } } : {}) });
    } else if (block.kind === 'checklist' && Array.isArray(block.items)) {
      const items = block.items.map(record).filter(item => typeof item.id === 'string' && typeof item.text === 'string').slice(0, 100)
        .map(item => ({ id: item.id as string, text: clip(item.text as string, 500), checked: item.checked === true }));
      if (!items.length) { hidden++; continue; }
      blocks.push({ id, kind: 'checklist', ...(text(block.title, 300) ? { title: text(block.title, 300)! } : {}), items });
    } else if (block.kind === 'interactive' && Array.isArray(block.options)) {
      // An option with a direct action calls a native endpoint instead of sending a chat message
      // (upstream F155: guides, feedback). Those operations are not adapted, so such a block is not
      // offered as an ordinary choice that would disable it without doing what it asks.
      if (block.options.some(option => record(option).action !== undefined)) { hidden++; continue; }
      const mode = block.interactiveType === 'confirm' ? 'confirm' as const : block.interactiveType === 'multi-select' ? 'multiple' as const : 'single' as const;
      let options = block.options.map(record).filter(option => typeof option.id === 'string' && typeof option.label === 'string').slice(0, 40)
        .map(option => ({ id: option.id as string, label: clip(option.label as string, 200),
          ...(text(option.emoji, 16) ? { emoji: text(option.emoji, 16)! } : {}), ...(text(option.description, 400) ? { description: text(option.description, 400)! } : {}),
          ...(option.customInput === true ? { custom: true as const } : {}) }));
      if (mode === 'confirm') {
        // Exactly two answers, chosen as the native web client does: the option called __confirm__ or
        // else the first one confirms; the first other one cancels, or a plain 取消 when none is declared.
        const yes = options.find(option => option.id === '__confirm__') ?? options[0] ?? { id: '__confirm__', label: '确认' };
        options = [yes, options.find(option => option.id !== yes.id) ?? { id: '__cancel__', label: '取消' }];
      }
      if (!options.length) { hidden++; continue; }
      const selected = Array.isArray(block.selectedIds) ? block.selectedIds.filter((value): value is string => typeof value === 'string') : [];
      blocks.push({ id, kind: 'choices', mode,
        ...(text(block.title, 300) ? { title: text(block.title, 300)! } : {}), ...(text(block.description, 1000) ? { description: text(block.description, 1000)! } : {}),
        options, ...(typeof block.maxSelect === 'number' && block.maxSelect > 0 ? { max: block.maxSelect } : {}),
        ...(text(block.messageTemplate, 1000) ? { template: text(block.messageTemplate, 1000)! } : {}),
        // Native marks a choice that was made by disabling the block and recording what was picked.
        answered: block.disabled === true || selected.length > 0, selected });
    } else if (block.kind === 'diff' && typeof block.diff === 'string' && typeof block.filePath === 'string') {
      const file = block.filePath.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '文件';
      blocks.push({ id, kind: 'diff', file: clip(file, 120), diff: clip(block.diff, 20000) });
    } else hidden++; // media, audio, widgets: not drawn yet
  }
  return { blocks, hidden };
}

/**
 * A message that carries a request for confirmation, as one line in the chat's words ("想设一个定时：每周五
 * 写周报 · 每周五 17:00"). The engine's own text of such a message ("请求批准创建定时任务「…」",
 * "提议捕捉品味信号：…") is written for its web client; previews and search use this line instead.
 */
export function requestLine(message: NativeMessage): string | undefined {
  if (message.type !== 'assistant') return undefined;
  const request = messageBlocks(message).blocks.find(block => block.kind === 'card' && block.approval);
  return request ? blockLine([request]) : undefined;
}

/** One line for a contact-list preview when a message has no words: what its first block is called. */
export function blockLine(blocks: ChatBlock[]): string {
  const first = blocks[0];
  if (!first) return '';
  if (first.kind === 'card' && first.approval) return first.approval.title + (first.approval.body ? `：${first.approval.body}` : '');
  return first.kind === 'diff' ? first.file : first.title ?? (first.kind === 'checklist' ? first.items[0]!.text : first.kind === 'choices' ? first.options.map(option => option.label).join(' / ') : '');
}
