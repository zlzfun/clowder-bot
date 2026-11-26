import { ApiError } from '../errors.js';
import { encode, type BotBridge } from './bridge.js';
import type { NativeCat } from './types.js';
import { clip } from './text.js';
import { changeWords, triggerWords } from './trigger-words.js';
export { triggerWords };

/**
 * What a cat asked the owner to confirm, in the words of a chat. The request,
 * its lifecycle and its effect stay native: this reads the native Approval Hub
 * and passes the owner's yes or no to the endpoint the hub's own manifest
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
    await this.bridge.thread(threadId);
    const [{ items, bases }, cats] = await Promise.all([this.pending(threadId), this.bridge.cats()]);
    return items.map(item => present(item, cats, bases.get(item.sourceFeatureId))).filter((card): card is ApprovalCard => !!card)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }
  /** The owner's answer goes to the native decision route; what it led to is read back, not assumed. */
  async decide(threadId: string, proposalId: string, decision: 'approve' | 'reject') {
    await this.bridge.thread(threadId);
    const { items, bases } = await this.pending(threadId), cats = await this.bridge.cats();
    const item = items.find(candidate => candidate.proposalId === proposalId);
    const card = item && present(item, cats, bases.get(item.sourceFeatureId));
    if (!item || !card) throw new ApiError(404, '这件事已经处理过，或者不在这个对话里');
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
