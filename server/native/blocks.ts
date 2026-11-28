import type { NativeMessage } from './types.js';
import { clip, plainLine } from './text.js';
import { changeWords, triggerWords } from './trigger-words.js';
import { runtimeCardBinding } from './runtime-interactions.js';
import { nativeUploadPath, ttsAudioPath } from './file-path.js';
import { isAllowedAudioUploadExt, isAllowedGalleryUploadExt, mediaToken } from './files.js';

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
      approval?: { id: string; kind: RequestKind; title: string; body?: string; state?: 'approved' | 'rejected' | 'closed'; selected?: string[] } }
  | { id: string; kind: 'checklist'; title?: string; items: Array<{ id: string; text: string; checked: boolean }> }
  | { id: string; kind: 'choices'; mode: 'single' | 'multiple' | 'confirm'; layout?: 'grid'; title?: string; description?: string;
      options: Array<{ id: string; label: string; emoji?: string; description?: string; custom?: true; customPlaceholder?: string; action?: { kind: 'callback' } }>;
      max?: number; template?: string; answered: boolean; selected: string[] }
  | { id: string; kind: 'diff'; file: string; diff: string }
  | { id: string; kind: 'gallery'; title?: string; items: Array<{ url: string; alt?: string; caption?: string }> }
  | { id: string; kind: 'audio'; url?: string; title?: string; text?: string; durationSec?: number; speaker?: string };

export interface RuntimeBlockState {
  state?: 'approved' | 'rejected' | 'closed';
  selected?: string[];
  body?: string;
}

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
      // The engine lists each changed parameter as a field of its own, "<name>": "<old JSON> → <new JSON>" (schedule-mutation-card-block.ts).
      const was: Record<string, unknown> = {}, next: Record<string, unknown> = {};
      if (change) for (const entry of (Array.isArray(block.fields) ? block.fields : []).map(record)) {
        if (typeof entry.label !== 'string' || typeof entry.value !== 'string' || ['Task ID', 'Template', 'Trigger', 'Delivery thread'].includes(entry.label)) continue;
        const cut = entry.value.lastIndexOf(' → ');
        if (cut < 0) continue;
        try { next[entry.label] = JSON.parse(entry.value.slice(cut + 3)); } catch { continue; }
        try { was[entry.label] = JSON.parse(entry.value.slice(0, cut)); } catch { /* not set before */ }
      }
      return { kind: 'schedule', title: remove ? '想取消一个定时' : change ? '想改一个定时' : '想设一个定时', ...body([label, when, changeWords(was, next)].filter(Boolean).join(' · ')) };
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
function runtimeCardApproval(message: NativeMessage, block: Record<string, unknown>, id: string): { proposal: string; producerId: string; kind?: string } | null {
  const meta = record(block.meta);
  if (block.kind === 'card' && meta.kind === 'runtime_interaction' && text(meta.interactionId, 200)) {
    return { proposal: text(meta.interactionId, 200)!, producerId: 'F306', ...(text(meta.interactionKind, 40) ? { kind: text(meta.interactionKind, 40)! } : {}) };
  }
  const binding = runtimeCardBinding(message);
  if (block.kind === 'interactive' && binding && binding.blockId === id && binding.requestKind === 'conversation_decision') {
    return { proposal: binding.interactionId, producerId: 'F306', kind: 'conversation_decision' };
  }
  return null;
}
/**
 * The receipts, among `decided`, that this message's request cards take their state from (the same rule and the same
 * cards as messageBlocks). Such a card says how it was answered, so the receipt need not be said again as a line.
 */
export function cardReceipts(message: NativeMessage, decided: ApprovalDecision[]): ApprovalDecision[] {
  const raw = record(message.extra?.rich).blocks, used: ApprovalDecision[] = [];
  for (const entry of Array.isArray(raw) ? raw.slice(0, 50) : []) {
    const block = record(entry), id = text(block.id, 200);
    if (!id) continue;
    const rt = runtimeCardApproval(message, block, id);
    if (rt) {
      const receipt = decided.find(item => answers(item, rt.proposal, rt.producerId, message.id));
      if (receipt) used.push(receipt);
      continue;
    }
    if (block.kind !== 'card' || !text(block.title, 300)) continue;
    const approval = record(record(block.meta).approval), proposal = text(approval.canonicalProposalId, 200);
    const receipt = proposal ? decided.find(item => answers(item, proposal, approval.producerId, message.id)) : undefined;
    if (receipt) used.push(receipt);
  }
  return used;
}
export interface MessageBlocksOptions {
  threadId?: string;
}

const FRUSTRATION_CALLBACK_RE = /^\/api\/frustration-issues\/([A-Za-z0-9_-]{1,200})\/(confirm|skip)$/;

/**
 * Upstream F155 option.action endpoints that are self-contained and safe to execute
 * from chat without requiring an unadapted React overlay (such as guide-actions/start).
 */
export function allowedCallbackEndpoint(endpoint: unknown): string | null {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('/api/') || endpoint.length > 500 || /[?#\\\s\x00-\x1f\x7f]/.test(endpoint)) {
    return null;
  }
  if (endpoint === '/api/guide-actions/cancel' || endpoint === '/api/auto-dream/life-settings/decision') {
    return endpoint;
  }
  if (FRUSTRATION_CALLBACK_RE.test(endpoint)) {
    return endpoint;
  }
  return null;
}

export function isAllowlistedCallbackAction(action: unknown): action is { type: 'callback'; endpoint: string; payload?: Record<string, unknown> } {
  const act = record(action);
  if (act.type !== 'callback') return false;
  if (!allowedCallbackEndpoint(act.endpoint)) return false;
  return act.payload === undefined || (!!act.payload && typeof act.payload === 'object' && !Array.isArray(act.payload));
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048 || /[\s\x00-\x1f\x7f]/.test(trimmed)) return null;
  if (!/^https:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function projectMediaUrl(
  rawUrl: unknown,
  kind: 'gallery' | 'audio',
  message: NativeMessage,
  blockIndex: number,
  itemIndex: number,
  threadId?: string,
): string | null {
  const https = safeHttpsUrl(rawUrl);
  if (https) return https;
  const tts = kind === 'audio' ? ttsAudioPath(rawUrl) : null;
  if (tts) {
    if (!threadId || message.isDraft) return tts;
    const token = mediaToken(threadId, message.id, kind, blockIndex, itemIndex, tts);
    return token ? `/xbot-api/media/${token}` : null;
  }
  const upload = nativeUploadPath(rawUrl);
  if (!upload) return null;
  if (kind === 'gallery' && !isAllowedGalleryUploadExt(upload)) return null;
  if (kind === 'audio' && !isAllowedAudioUploadExt(upload)) return null;
  if (!threadId || message.isDraft) return upload;
  const token = mediaToken(threadId, message.id, kind, blockIndex, itemIndex, upload);
  return token ? `/xbot-api/media/${token}` : null;
}

export function messageBlocks(
  message: NativeMessage,
  decided: ApprovalDecision[] = [],
  runtimeStates: ReadonlyMap<string, RuntimeBlockState> = new Map(),
  options: MessageBlocksOptions = {},
): { blocks: ChatBlock[]; hidden: number } {
  const raw = record(message.extra?.rich).blocks, blocks: ChatBlock[] = [];
  let hidden = 0;
  for (const [blockIndex, entry] of (Array.isArray(raw) ? raw.slice(0, 50) : []).entries()) {
    const block = record(entry), id = text(block.id, 200);
    if (!id) { hidden++; continue; }
    if (block.kind === 'file') continue;
    // The summary card of one remember call only refers to other cards and receipts; the line it becomes is said by engineNote.
    if (block.kind === 'card' && record(block.meta).kind === 'memory_group') continue;
    const rt = runtimeCardApproval(message, block, id);
    if (rt && rt.kind === 'conversation_decision' && block.kind === 'interactive') {
      const receiptState = decided.find(receipt => answers(receipt, rt.proposal, rt.producerId, message.id))?.state;
      const rtState = runtimeStates.get(rt.proposal);
      const selectedIds = Array.isArray(block.selectedIds) ? block.selectedIds.filter((v): v is string => typeof v === 'string') : [];
      const optionLabels = (Array.isArray(block.options) ? block.options : []).map(record)
        .filter(o => typeof o.id === 'string' && selectedIds.includes(o.id) && typeof o.label === 'string')
        .map(o => clip(o.label as string, 200));
      const state = receiptState ?? rtState?.state ?? (block.disabled === true ? 'approved' : undefined);
      const selected = rtState?.selected?.length ? rtState.selected : optionLabels;
      const body = rtState?.body ?? (text(block.title, 300) || text(block.description, 1000) || text(message.content, 300));
      blocks.push({
        id, kind: 'card', title: text(block.title, 300) ?? '有件事要问你',
        ...(text(block.description, 1000) ? { body: text(block.description, 1000)! } : {}),
        approval: {
          id: rt.proposal, kind: 'question', title: '有件事要问你',
          ...(body ? { body } : {}),
          ...(state ? { state } : {}),
          ...(selected.length ? { selected } : {}),
        },
      });
      continue;
    }
    if (block.kind === 'card' && text(block.title, 300)) {
      const approval = record(record(block.meta).approval);
      const proposal = rt ? rt.proposal : text(approval.canonicalProposalId, 200);
      const producerId = rt ? rt.producerId : approval.producerId;
      const receiptState = proposal ? decided.find(receipt => answers(receipt, proposal, producerId, message.id))?.state : undefined;
      const rtState = rt ? runtimeStates.get(rt.proposal) : undefined;
      const state = receiptState ?? rtState?.state;
      const selected = rtState?.selected;
      const fields = (Array.isArray(block.fields) ? block.fields : []).map(record)
        .filter(field => typeof field.label === 'string' && typeof field.value === 'string').slice(0, 20)
        .map(field => ({ label: clip(field.label as string, 80), value: clip(field.value as string, 400) }));
      const approvalWords = rt ? (() => {
        const reqKind: RequestKind = rt.kind === 'question' ? 'question' : 'other';
        const title = rt.kind === 'question' ? '有件事要问你' : rt.kind === 'elicitation' ? '需要你补充信息' : '有件事等你确认';
        const body = rtState?.body ?? (text(block.title, 300) || plainLine((typeof block.bodyMarkdown === 'string' ? block.bodyMarkdown : '').trim().split(/\n\s*\n/)[0] ?? ''));
        return { kind: reqKind, title, ...(body ? { body: clip(body, 400) } : {}) };
      })() : requestWords(approval.producerId, block);
      blocks.push({ id, kind: 'card', title: text(block.title, 300)!, ...(text(block.bodyMarkdown, 8000) ? { body: text(block.bodyMarkdown, 8000)! } : {}),
        ...(tones.includes(block.tone as never) ? { tone: block.tone as typeof tones[number] } : {}), ...(fields.length ? { fields } : {}),
        ...(proposal ? { approval: { id: proposal, ...approvalWords, ...(state ? { state } : {}), ...(selected?.length ? { selected } : {}) } } : {}) });
    } else if (block.kind === 'checklist' && Array.isArray(block.items)) {
      const items = block.items.map(record).filter(item => typeof item.id === 'string' && typeof item.text === 'string').slice(0, 100)
        .map(item => ({ id: item.id as string, text: clip(item.text as string, 500), checked: item.checked === true }));
      if (!items.length) { hidden++; continue; }
      blocks.push({ id, kind: 'checklist', ...(text(block.title, 300) ? { title: text(block.title, 300)! } : {}), items });
    } else if (block.kind === 'interactive' && Array.isArray(block.options)) {
      const mode = block.interactiveType === 'confirm' ? 'confirm' as const : block.interactiveType === 'multi-select' ? 'multiple' as const : 'single' as const;
      // Any option with an unallowlisted action (e.g. guide-actions/start or untrusted URL),
      // or any multi-select block carrying callback actions (upstream requires single-option callback),
      // keeps the whole block in hidden++ so we never offer a dead or broken button.
      const hasAction = block.options.some(option => record(option).action !== undefined);
      if (hasAction && (mode === 'multiple' || block.options.some(option => record(option).action !== undefined && !isAllowlistedCallbackAction(record(option).action)))) {
        hidden++; continue;
      }
      const layout = block.interactiveType === 'card-grid' ? 'grid' as const : undefined;
      let optionsList = block.options.map(record).filter(option => typeof option.id === 'string' && typeof option.label === 'string').slice(0, 40)
        .map(option => ({ id: option.id as string, label: clip(option.label as string, 200),
          ...(text(option.emoji, 16) ? { emoji: text(option.emoji, 16)! } : {}), ...(text(option.description, 400) ? { description: text(option.description, 400)! } : {}),
          ...(option.customInput === true ? { custom: true as const } : {}),
          ...(option.customInput === true && text(option.customInputPlaceholder, 200) ? { customPlaceholder: text(option.customInputPlaceholder, 200)! } : {}),
          ...(isAllowlistedCallbackAction(option.action) ? { action: { kind: 'callback' as const } } : {}) }));
      if (mode === 'confirm') {
        // Exactly two answers, chosen as the native web client does: the option called __confirm__ or
        // else the first one confirms; the first other one cancels, or a plain 取消 when none is declared.
        const yes = optionsList.find(option => option.id === '__confirm__') ?? optionsList[0] ?? { id: '__confirm__', label: '确认' };
        optionsList = [yes, optionsList.find(option => option.id !== yes.id) ?? { id: '__cancel__', label: '取消' }];
      }
      if (!optionsList.length) { hidden++; continue; }
      const selected = Array.isArray(block.selectedIds) ? block.selectedIds.filter((value): value is string => typeof value === 'string') : [];
      blocks.push({ id, kind: 'choices', mode, ...(layout ? { layout } : {}),
        ...(text(block.title, 300) ? { title: text(block.title, 300)! } : {}), ...(text(block.description, 1000) ? { description: text(block.description, 1000)! } : {}),
        options: optionsList, ...(typeof block.maxSelect === 'number' && block.maxSelect > 0 ? { max: block.maxSelect } : {}),
        ...(text(block.messageTemplate, 1000) ? { template: text(block.messageTemplate, 1000)! } : {}),
        // Native marks a choice that was made by disabling the block and recording what was picked.
        answered: block.disabled === true || selected.length > 0, selected });
    } else if (block.kind === 'diff' && typeof block.diff === 'string' && typeof block.filePath === 'string') {
      const file = block.filePath.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '文件';
      blocks.push({ id, kind: 'diff', file: clip(file, 120), diff: clip(block.diff, 20000) });
    } else if (block.kind === 'media_gallery' && Array.isArray(block.items)) {
      const items = block.items.slice(0, 50).flatMap((rawItem, itemIndex) => {
        const item = record(rawItem);
        const url = projectMediaUrl(item.url, 'gallery', message, blockIndex, itemIndex, options.threadId);
        if (!url) return [];
        const alt = text(item.alt, 300);
        const caption = text(item.caption, 500);
        return [{ url, ...(alt ? { alt } : {}), ...(caption ? { caption } : {}) }];
      });
      if (!items.length) { hidden++; continue; }
      blocks.push({ id, kind: 'gallery', ...(text(block.title, 300) ? { title: text(block.title, 300)! } : {}), items });
    } else if (block.kind === 'audio') {
      const rawUrl = typeof block.url === 'string' ? block.url.trim() : '';
      const url = rawUrl ? projectMediaUrl(rawUrl, 'audio', message, blockIndex, 0, options.threadId) : null;
      const transcript = text(block.text, 8000);
      if (rawUrl && !url) { hidden++; continue; }
      if (!url && !transcript) { hidden++; continue; }
      const durationSec = typeof block.durationSec === 'number' && Number.isFinite(block.durationSec) && block.durationSec > 0 ? block.durationSec : undefined;
      const speaker = text(block.speaker, 100);
      blocks.push({
        id, kind: 'audio',
        ...(url ? { url } : {}),
        ...(text(block.title, 300) ? { title: text(block.title, 300)! } : {}),
        ...(transcript ? { text: transcript } : {}),
        ...(durationSec !== undefined ? { durationSec } : {}),
        ...(speaker ? { speaker } : {}),
      });
    } else hidden++; // html_widget and unknown kinds remain counted in blocks_hidden
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
  if (first.kind === 'diff') return first.file;
  if (first.kind === 'gallery') return first.title ?? (plainLine(first.items[0]?.caption || first.items[0]?.alt || '') || '图片');
  if (first.kind === 'audio') return first.title ?? (first.text ? clip(plainLine(first.text) || first.text, 80) : '语音消息');
  return first.title ?? (first.kind === 'checklist' ? first.items[0]!.text : first.kind === 'choices' ? first.options.map(option => option.label).join(' / ') : '');
}
