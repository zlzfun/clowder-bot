import { randomUUID } from 'node:crypto';
import { ApiError } from '../errors.js';
import { encode, type BotBridge } from './bridge.js';
import type { NativeCat, NativeMessage } from './types.js';
import { clip } from './text.js';
import { changeWords, triggerWords } from './trigger-words.js';
import { approvalReceipt } from './message-presentation.js';
import {
  readRuntimeInteraction,
  readRuntimeInteractions,
  runtimeCardBinding,
  runtimePrompt,
  runtimeSummary,
  runtimeTerminalState,
  validateRuntimeResponse,
  type RuntimePrompt,
  type RuntimeRecord,
} from './runtime-interactions.js';
export { triggerWords };
export type { RuntimePrompt } from './runtime-interactions.js';

/**
 * What a cat asked the owner to confirm, in the words of a chat. The request,
 * its lifecycle and its effect stay native: this reads the native Approval Hub
 * and Runtime Interactions and passes the owner's answer to the endpoint native
 * names for that kind of request. Nothing is approved automatically.
 */
export interface ApprovalCard {
  id: string;
  kind: 'preference' | 'profile' | 'person' | 'schedule' | 'question' | 'other';
  title: string; body: string; quote?: string;
  catId?: string; catName?: string;
  /** The chat message that carries the native request card. */
  messageId: string; createdAt?: number; expiresAt?: number;
  state: 'open' | 'approved' | 'rejected' | 'closed';
  /** Null when it cannot be answered from the chat; `note` says where instead. */
  approve: { label: string } | null; reject: { label: string } | null; note?: string;
  /** Structured prompt details for F306 runtime interactions answerable inline in chat. */
  runtime?: RuntimePrompt;
}
export interface SettledApprovalState {
  id: string;
  state: 'approved' | 'rejected' | 'closed';
  selected?: string[];
}
export interface ApprovalDecideInput {
  decision?: 'approve' | 'reject';
  response?: unknown;
  expectedRevision?: number;
  operationId?: string;
}
type Item = Record<string, any>;
const record = (value: unknown): Item => value && typeof value === 'object' && !Array.isArray(value) ? value as Item : {};
const words = (value: unknown, max = 400): string => typeof value === 'string' ? clip(value.trim(), max) : '';
// The decision routes the Bot may reach; the hub manifest picks one of them per kind of request.
const decisionBases = /^\/api\/(?:proposals|session-handoff|dispatch-proposals|taste-proposals|profile-updates|person-memory-proposals|entity-proposals|event-memory-corrections|schedule-proposals|eval-repair-proposals)$/;
/**
 * A pending request in a few everyday words, for the one-line status above the
 * composer and the contact list ("等你确认：…"). The hub's own summaries are in
 * the engine's wording ("Create schedule: 每周五写周报", "Profile update: …").
 */
export function approvalLine(item: Record<string, unknown>): string {
  const summary = typeof item.summary === 'string' ? item.summary.replace(/\s+/g, ' ').trim() : '', detail = record(item.detail);
  switch (item.sourceFeatureId) {
    case 'F221': return '记住你的一个偏好';
    case 'F231': return '更新关于你的资料';
    case 'F276': return '记下一位相关的人';
    case 'F139': {
      const label = clip(summary.replace(/^(?:Create|Delete|Update) schedule:\s*/, ''), 60);
      return `${detail.mutationKind === 'delete' ? '取消一个定时' : detail.mutationKind === 'update' ? '改一个定时' : '设一个定时'}${label ? `「${label}」` : ''}`;
    }
    default: return clip(summary, 160);
  }
}

function presentRuntimeInteraction(interaction: RuntimeRecord, cats: NativeCat[]): ApprovalCard | null {
  const req = record(interaction.request), cardRef = record(interaction.cardRef), owner = record(req.owner);
  const id = typeof req.interactionId === 'string' ? req.interactionId : '';
  if (!id || typeof cardRef.messageId !== 'string') return null;
  const cat = cats.find(known => known.id === owner.catId), who = cat?.name ?? '猫猫';
  const expiresAt = req.kind === 'conversation_decision' && typeof req.deadlineAt === 'number' ? req.deadlineAt : undefined;
  const shared = {
    id, messageId: cardRef.messageId, state: 'open' as const,
    ...(cat ? { catId: cat.id, catName: cat.name } : {}),
    ...(typeof req.createdAt === 'number' ? { createdAt: req.createdAt } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
  const prompt = runtimePrompt(interaction);
  if (!prompt) {
    return { ...shared, kind: 'question', title: `${who}有件事要问你`, body: words(req.title) || words(req.description),
      approve: null, reject: null, note: '这一项要在运行面板里回答' };
  }
  if (prompt.kind === 'question') {
    const body = words(req.description) || (prompt.questions.length === 1 ? words(prompt.questions[0]!.question) : words(req.title));
    return { ...shared, kind: 'question', title: `${who}有件事要问你`, body,
      approve: { label: '提交回答' }, reject: { label: '拒绝' }, runtime: prompt };
  }
  if (prompt.kind === 'approval') {
    const body = [words(req.title), words(req.description)].filter(Boolean).join('\n');
    const accept = prompt.decisions.find(d => d.outcome === 'accept') ?? prompt.decisions[0]!;
    return { ...shared, kind: 'other', title: `${who}有件事等你确认`, body,
      approve: { label: accept.label }, reject: null, runtime: prompt };
  }
  if (prompt.kind === 'elicitation') {
    const accept = prompt.decisions.find(d => d.outcome === 'accept') ?? prompt.decisions[0]!;
    return { ...shared, kind: 'other', title: `${who}需要你补充信息`, body: words(req.message) || words(req.title),
      approve: { label: accept.label }, reject: null, runtime: prompt };
  }
  const body = [words(req.title), words(req.description)].filter(Boolean).join('\n');
  return { ...shared, kind: 'question', title: `${who}有件事要问你`, body,
    approve: { label: '确认' }, reject: null, runtime: prompt };
}

function present(item: Item, cats: NativeCat[], base: string | undefined): ApprovalCard | null {
  const nav = record(item.navigation), card = record(nav.approvalCardRef), detail = record(item.detail);
  if (typeof item.proposalId !== 'string' || nav.state !== 'anchored' || typeof card.messageId !== 'string') return null;
  const cat = cats.find(known => known.id === item.requesterCatId), who = cat?.name ?? '猫猫';
  // Agreeing needs a request the hub allows to be approved in place and a decision route the Bot may reach.
  const inline = item.inlineApprovable === true && item.decisionMode === 'approve-reject' && !!base;
  const shared = { id: item.proposalId, messageId: card.messageId, state: 'open' as const,
    ...(cat ? { catId: cat.id, catName: cat.name } : {}),
    ...(typeof item.createdAt === 'number' ? { createdAt: item.createdAt } : {}), ...(typeof item.expiresAt === 'number' ? { expiresAt: item.expiresAt } : {}) };
  const elsewhere = { approve: null, note: '这一项要在运行面板里核对后才能同意' };
  const summary = words(item.summary);
  switch (item.sourceFeatureId) {
    case 'F221': return { ...shared, kind: 'preference', title: `${who}想记住你的一个偏好`, body: words(detail.takeaway) || summary,
      ...(words(detail.quote) ? { quote: words(detail.quote, 200) } : {}),
      ...(inline ? { approve: { label: '记住' } } : elsewhere), reject: base ? { label: '不用记' } : null };
    case 'F231': return { ...shared, kind: 'profile', title: `${who}想更新关于你的资料`, body: words(detail.rationale) || summary.replace(/^(?:Profile|Corpus) update:\s*/, ''),
      ...(inline ? { approve: { label: '更新' } } : elsewhere), reject: base ? { label: '不用' } : null };
    case 'F276': return { ...shared, kind: 'person', title: `${who}想记下一位相关的人`, body: summary,
      ...(inline ? { approve: { label: '记下' } } : elsewhere), reject: base ? { label: '不用记' } : null };
    case 'F139': {
      // The engine proposes three things about a timer: making one, deleting one and (since its parameter updates) changing one.
      const label = summary.replace(/^(?:Create|Delete|Update) schedule:\s*/, '') || '定时任务', remove = detail.mutationKind === 'delete', change = detail.mutationKind === 'update';
      return { ...shared, kind: 'schedule', title: remove ? `${who}想取消一个定时` : change ? `${who}想改一个定时` : `${who}想设一个定时`,
        // A change says what it changes: agreeing to "改吧" without that is not a choice.
        body: [label, triggerWords(detail.trigger), change ? changeWords(detail.previousParams, detail.params) : ''].filter(Boolean).join(' · '),
        ...(inline ? { approve: { label: remove ? '取消它' : change ? '改吧' : '设上' } } : elsewhere), reject: base ? { label: remove ? '先留着' : change ? '先不改' : '不用' } : null };
    }
    case 'F306': return { ...shared, kind: 'question', title: `${who}有件事要问你`, body: summary, approve: null, reject: null, note: '这一项要在运行面板里回答' };
    default: return { ...shared, kind: 'other', title: `${who}有件事等你确认`, body: summary,
      ...(inline ? { approve: { label: '同意' } } : elsewhere), reject: base ? { label: '拒绝' } : null };
  }
}

export class Approvals {
  constructor(private bridge: BotBridge) {}
  private async pending(threadId: string) {
    const hub = await this.bridge.native.request<{ items?: unknown; manifest?: unknown }>('/api/approval-hub/pending');
    if (!Array.isArray(hub.items)) throw new ApiError(502, '暂时读不到等你确认的事');
    const bases = new Map<string, string>();
    for (const entry of Array.isArray(hub.manifest) ? hub.manifest : []) {
      const row = record(entry);
      if (typeof row.id === 'string' && typeof row.decisionEndpointBase === 'string' && decisionBases.test(row.decisionEndpointBase)) bases.set(row.id, row.decisionEndpointBase);
    }
    const items = hub.items.map(record).filter(item => item.resolution === 'open'
      && record(record(item.navigation).approvalCardRef).threadId === threadId);
    return { items, bases };
  }
  /** The requests waiting for the owner in this conversation. */
  async list(threadId: string): Promise<ApprovalCard[]> {
    return (await this.listView(threadId)).approvals;
  }
  /** Open requests in this conversation, plus native settled states for requested off-page IDs. */
  async listView(threadId: string, extraIds: string[] = []): Promise<{ approvals: ApprovalCard[]; settled: SettledApprovalState[] }> {
    await this.bridge.thread(threadId);
    const [{ items, bases }, page, cats] = await Promise.all([
      this.pending(threadId),
      this.bridge.messages(threadId),
      this.bridge.cats(),
    ]);
    const receiptSettled = new Set(
      page.messages.map(approvalReceipt).filter((r): r is NonNullable<typeof r> => !!r && r.producerId === 'F306').map(r => r.proposalId),
    );
    const hubF306Ids = items.filter(i => i.sourceFeatureId === 'F306' && typeof i.proposalId === 'string').map(i => String(i.proposalId));
    const messageF306Ids = page.messages
      .map(runtimeCardBinding)
      .filter((b): b is NonNullable<typeof b> => !!b && !receiptSettled.has(b.interactionId))
      .map(b => b.interactionId);
    const interactions = await readRuntimeInteractions(this.bridge.native, [...hubF306Ids, ...messageF306Ids, ...extraIds], { strict: true });

    const cards: ApprovalCard[] = [];
    const seenIds = new Set<string>();
    for (const item of items) {
      if (typeof item.proposalId !== 'string') continue;
      if (item.sourceFeatureId === 'F306') {
        const rec = interactions.get(item.proposalId);
        if (rec) {
          if (rec.status !== 'pending') continue;
          const card = presentRuntimeInteraction(rec, cats);
          if (card) { cards.push(card); seenIds.add(card.id); continue; }
        }
      }
      const card = present(item, cats, bases.get(item.sourceFeatureId));
      if (card) { cards.push(card); seenIds.add(card.id); }
    }
    // Upstream's F306ApprovalAdapter only lists `approval` in approval-hub/pending;
    // `question`, `elicitation` and `conversation_decision` are read directly via runtime-interactions.
    for (const id of [...messageF306Ids, ...extraIds]) {
      if (seenIds.has(id)) continue;
      const rec = interactions.get(id);
      if (!rec || rec.status !== 'pending') continue;
      const cardThread = record(rec.cardRef).threadId ?? record(record(rec.request).owner).threadId;
      if (cardThread !== threadId) continue;
      const card = presentRuntimeInteraction(rec, cats);
      if (card) { cards.push(card); seenIds.add(card.id); }
    }
    cards.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

    const settled: SettledApprovalState[] = [];
    const settledSeen = new Set<string>();
    const unresolvedExtra: string[] = [];
    for (const id of extraIds) {
      if (seenIds.has(id) || settledSeen.has(id)) continue;
      const rec = interactions.get(id);
      const belongs = rec && (record(rec.cardRef).threadId === threadId || record(record(rec.request).owner).threadId === threadId);
      const terminal = belongs ? runtimeTerminalState(rec!) : null;
      if (terminal) {
        settled.push({ id, state: terminal.state, ...(terminal.selected ? { selected: terminal.selected } : {}) });
        settledSeen.add(id);
      } else {
        unresolvedExtra.push(id);
      }
    }
    if (unresolvedExtra.length) {
      const hubSettled = await this.bridge.native.request<{ items?: unknown }>('/api/approval-hub/settled?limit=200').catch(error => {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      });
      for (const raw of Array.isArray(hubSettled?.items) ? hubSettled.items : []) {
        const row = record(raw), cardRef = record(record(row.navigation).approvalCardRef);
        const id = typeof row.proposalId === 'string' ? row.proposalId : '';
        if (!id || settledSeen.has(id) || !unresolvedExtra.includes(id) || cardRef.threadId !== threadId) continue;
        const state: SettledApprovalState['state'] =
          row.status === 'approved' ? 'approved' : row.status === 'rejected' ? 'rejected' : 'closed';
        const labels = Array.isArray(record(row.detail).runtimeSelectedLabels)
          ? (record(row.detail).runtimeSelectedLabels as unknown[]).filter((s): s is string => typeof s === 'string' && !!s.trim())
          : [];
        settled.push({ id, state, ...(labels.length ? { selected: labels } : {}) });
        settledSeen.add(id);
      }
    }
    return { approvals: cards, settled };
  }

  private async decideRuntime(
    threadId: string,
    proposalId: string,
    recordObj: RuntimeRecord,
    opts: ApprovalDecideInput,
  ) {
    const cardRef = record(recordObj.cardRef), req = record(recordObj.request), owner = record(req.owner);
    const belongs = cardRef.threadId === threadId || owner.threadId === threadId;
    const sameOp = req.kind === 'conversation_decision'
      && typeof opts.operationId === 'string' && !!opts.operationId
      && (record(recordObj.submission).operationId === opts.operationId || record(recordObj.terminal).operationId === opts.operationId);
    if (!belongs || typeof cardRef.messageId !== 'string' || typeof cardRef.blockId !== 'string' || (recordObj.status !== 'pending' && !sameOp)) {
      throw new ApiError(404, '这件事已经处理过，或者不在这个对话里');
    }
    if (!sameOp && opts.expectedRevision !== undefined && opts.expectedRevision !== recordObj.revision) {
      throw new ApiError(409, '这件事状态已经变化，请刷新后再试');
    }
    const rejectOnly = opts.decision === 'reject' && opts.response === undefined;
    if (rejectOnly && req.kind !== 'question') {
      throw new ApiError(409, '这一项需要在卡片里选择具体处理方式');
    }
    const prompt = runtimePrompt(recordObj);
    if (!rejectOnly && !prompt) throw new ApiError(409, '这一项要在运行面板里回答');
    const cleanResponse = rejectOnly ? undefined : validateRuntimeResponse(recordObj, opts.response);
    const expectedRevision = opts.expectedRevision ?? (typeof recordObj.revision === 'number' && Number.isInteger(recordObj.revision) && recordObj.revision > 0
      ? recordObj.revision : undefined);
    let posted: { interaction?: unknown } | undefined;
    try {
      if (rejectOnly) {
        posted = await this.bridge.native.request<{ interaction?: unknown }>(`/api/runtime-interactions/${encode(proposalId)}/reject`, {
          method: 'POST',
          body: { cardRef },
        });
      } else {
        posted = await this.bridge.native.request<{ interaction?: unknown }>(`/api/runtime-interactions/${encode(proposalId)}/respond`, {
          method: 'POST',
          body: {
            cardRef,
            ...(expectedRevision !== undefined ? { expectedRevision } : {}),
            operationId: opts.operationId ?? randomUUID(),
            response: cleanResponse,
          },
        });
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) throw error;
      if (error instanceof ApiError) {
        if (error.status === 404) throw new ApiError(404, '这件事已经处理过，或者不在这个对话里', error.details ?? { error: error.message });
        if (error.status === 409) throw new ApiError(409, '这件事状态已经变化，请刷新后再试', error.details ?? { error: error.message });
        if (error.status === 400) throw new ApiError(400, '请检查你的回答是否完整有效', error.details ?? { error: error.message });
        throw new ApiError(error.status, rejectOnly ? '这一步没有成功，这件事仍在等你确认' : '这一步没有成功，还没有生效', error.details ?? { error: error.message });
      }
      throw error;
    }
    const returned = record(posted?.interaction);
    const after = typeof returned.status === 'string' && record(returned.request).interactionId === proposalId
      ? returned
      : await readRuntimeInteraction(this.bridge.native, proposalId).catch(() => null);
    if (!after) {
      return { id: proposalId, decision: rejectOnly ? 'reject' as const : 'approve' as const, settled: null };
    }
    const terminal = runtimeTerminalState(after);
    if (!terminal) {
      return { id: proposalId, decision: rejectOnly ? 'reject' as const : 'approve' as const, settled: false };
    }
    const summaryLine = runtimeSummary(after);
    return {
      id: proposalId,
      decision: terminal.state === 'rejected' ? 'reject' as const : 'approve' as const,
      settled: true,
      state: terminal.state,
      ...(terminal.selected?.length ? { selected: terminal.selected } : {}),
      ...(summaryLine ? { summary: summaryLine } : {}),
    };
  }

  /** The owner's answer goes to the native decision route; what it led to is read back, not assumed. */
  async decide(threadId: string, proposalId: string, input: 'approve' | 'reject' | ApprovalDecideInput) {
    const opts: ApprovalDecideInput = typeof input === 'string' ? { decision: input } : input;
    await this.bridge.thread(threadId);
    if (opts.response !== undefined) {
      const rec = await readRuntimeInteraction(this.bridge.native, proposalId, { strict: true });
      if (rec) return this.decideRuntime(threadId, proposalId, rec, opts);
      const { items } = await this.pending(threadId);
      if (items.some(candidate => candidate.proposalId === proposalId)) {
        throw new ApiError(400, '这一项不需要填写回答');
      }
      throw new ApiError(404, '这件事已经处理过，或者不在这个对话里');
    }
    const decision = opts.decision ?? 'approve';
    const { items, bases } = await this.pending(threadId), cats = await this.bridge.cats();
    const item = items.find(candidate => candidate.proposalId === proposalId);
    if (!item || item.sourceFeatureId === 'F306') {
      const rec = await readRuntimeInteraction(this.bridge.native, proposalId, { strict: true });
      if (rec) return this.decideRuntime(threadId, proposalId, rec, opts);
      if (!item) throw new ApiError(404, '这件事已经处理过，或者不在这个对话里');
      throw new ApiError(409, '这一项要在运行面板里回答');
    }
    const card = present(item, cats, bases.get(item.sourceFeatureId));
    if (!card) throw new ApiError(404, '这件事已经处理过，或者不在这个对话里');
    if (!(decision === 'approve' ? card.approve : card.reject)) throw new ApiError(409, card.note ?? '这一项不能在这里处理');
    try {
      // A preference that will be published is approved only as the content the hub listed (its digest); the engine
      // refuses the approval when what it holds has changed since. Other requests take no body.
      const digest = decision === 'approve' && item.sourceFeatureId === 'F221' ? record(item.detail).decisionDigest : undefined;
      await this.bridge.native.request(`${bases.get(item.sourceFeatureId)}/${encode(proposalId)}/${decision}`, { method: 'POST',
        body: typeof digest === 'string' && digest ? { decisionDigest: digest } : {} });
    } catch (error) {
      // The native reason stays attached for diagnosis; the chat says plainly that nothing was applied.
      if (error instanceof ApiError && error.status !== 503)
        throw new ApiError(error.status, decision === 'approve' ? '这一步没有成功，还没有生效' : '这一步没有成功，这件事仍在等你确认', error.details ?? { error: error.message });
      throw error;
    }
    // Settled means the hub no longer lists it as open; a request native is still applying stays open and says so.
    const after = await this.pending(threadId).catch(() => null);
    const still = after?.items.find(candidate => candidate.proposalId === proposalId);
    return { id: proposalId, decision, settled: after ? !still : null };
  }
}
