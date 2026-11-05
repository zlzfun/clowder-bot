import { ApiError } from '../errors.js';
import type { BotBridge, QueueView } from './bridge.js';
import { messagePresentation } from './message-presentation.js';
import type { NativeCat, NativeMessage } from './types.js';

export interface ActivityItem {
  id: string; kind: 'approval'|'failure'|'running'|'queued'|'task'; label: string; threadId: string;
  catId?: string; catName?: string; messageId?: string; taskId?: string; proposalId?: string;
}
export interface ActivityView {
  threadId: string; readStatus: 'ready'|'partial'|'unavailable'; items: ActivityItem[];
  counts: Record<ActivityItem['kind'], number>; unread: number|null; unreadHasMore: boolean; latestMessageId: string|null;
  errors: Array<{ source: string; message: string }>;
  active: QueueView['activeInvocations']; queued: QueueView['queue'];
}
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const orderTime = (message: NativeMessage) => message.timelineOrderAt ?? message.timestamp;
const after = (message: NativeMessage, cursor?: {messageId: string; orderTime: number}) => !cursor
  || orderTime(message) > cursor.orderTime || (orderTime(message) === cursor.orderTime && message.id > cursor.messageId);
const rank = { approval: 0, failure: 1, running: 2, queued: 3, task: 4 };

/** Reads of native facts plus human read positions. No lifecycle, scheduler or decision authority. */
export class Activity {
  constructor(private bridge: BotBridge) {}
  approvals(): Promise<{ items: unknown[] }> { return this.bridge.native.request('/api/approval-hub/pending'); }
  visibleReplies(threadId: string, messages: NativeMessage[]) {
    const presentation = messagePresentation(messages);
    return messages.filter(message => message.catId && message.type === 'assistant' && !message.isDraft
      && !['queued', 'processing', 'canceled', 'cancelled'].includes(message.lifecycle?.status ?? '')
      && presentation.get(message.id) !== 'activity'
      && ((!!message.content.trim() && message.content.trim() !== 'SILENT') || message.lifecycle?.status === 'failed' || this.bridge.workspaces.messageFiles(threadId, message).length > 0))
      .sort((a, b) => orderTime(a) - orderTime(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  unavailable(threadId: string): ActivityView {
    return { threadId, readStatus: 'unavailable', items: [], counts: { approval: 0, failure: 0, running: 0, queued: 0, task: 0 },
      unread: null, unreadHasMore: false, latestMessageId: null, active: [], queued: [], errors: [{source:'thread',message:'暂时无法确认进度'}] };
  }
  async read(threadId: string, cats?: NativeCat[], pending?: Promise<{items: unknown[]}>): Promise<ActivityView> {
    await this.bridge.thread(threadId);
    const names = cats ?? await this.bridge.cats();
    const view = this.unavailable(threadId); view.errors = [];
    const annotate = (catId: unknown) => typeof catId === 'string' ? {catId, catName: names.find(cat => cat.id === catId)?.name ?? catId} : {};
    const inputs = await Promise.allSettled([
      this.bridge.queue(threadId),
      this.bridge.native.request<{tasks: unknown[]}>(`/api/tasks?threadId=${encodeURIComponent(threadId)}`),
      this.bridge.messages(threadId),
      pending ?? this.approvals(),
    ]);
    const sources = ['queue', 'tasks', 'messages', 'approvals'];
    let ready = 0;
    for (const [index, result] of inputs.entries()) {
      if (result.status === 'rejected') { view.errors.push({source:sources[index]!,message:'暂时无法确认进度，请重试'}); continue; }
      try {
        const data = record(result.value);
        if (index === 0) {
          if (!Array.isArray(data.queue) || !Array.isArray(data.activeInvocations)) throw new Error('queue unavailable');
          view.active = data.activeInvocations; view.queued = data.queue;
          for (const raw of data.activeInvocations) {
            const item = record(raw), who = annotate(item.catId);
            view.items.push({id:`running:${item.invocationId ?? item.catId}`,kind:'running',threadId,...who,label:`${who.catName ?? '猫猫'}正在处理`});
          }
          for (const raw of data.queue) {
            const item = record(raw);
            if (!['queued', 'pending'].includes(item.status)) continue;
            const targets = item.targetCatId ? [item.targetCatId] : Array.isArray(item.targetCats) ? item.targetCats : [];
            const who = annotate(targets.length === 1 ? targets[0] : undefined);
            view.items.push({id:`queued:${item.id}`,kind:'queued',threadId,...who,label:who.catName ? `${who.catName}的消息排队中` : '消息排队中',
              ...(typeof item.userMessageId === 'string' ? {messageId:item.userMessageId} : {})});
          }
        } else if (index === 1) {
          if (!Array.isArray(data.tasks)) throw new Error('tasks unavailable');
          for (const raw of data.tasks) {
            const item = record(raw);
            if (item.threadId !== threadId || !['todo', 'doing', 'blocked'].includes(item.status) || typeof item.id !== 'string') continue;
            view.items.push({id:`task:${item.id}`,kind:'task',threadId,taskId:item.id,...annotate(item.ownerCatId),
              label:`${typeof item.title === 'string' ? item.title : '任务'} · ${{todo:'待办',doing:'进行中',blocked:'受阻'}[item.status as 'todo'|'doing'|'blocked']}`,
              ...(typeof item.sourceMessageId === 'string' ? {messageId:item.sourceMessageId} : {})});
          }
        } else if (index === 2) {
          if (!Array.isArray(data.messages) || typeof data.hasMore !== 'boolean') throw new Error('messages unavailable');
          const replies = this.visibleReplies(threadId, data.messages), cursor = this.bridge.store.state.readCursors[threadId];
          const unread = replies.filter(message => after(message, cursor));
          view.unread = unread.length;
          const oldest = data.messages[0] as NativeMessage|undefined;
          view.unreadHasMore = data.hasMore && (!cursor || !!oldest && after(oldest, cursor));
          view.latestMessageId = replies.at(-1)?.id ?? null;
          for (const message of unread) if (message.lifecycle?.status === 'failed') {
            const who = annotate(message.catId);
            view.items.push({id:`failure:${message.id}`,kind:'failure',threadId,messageId:message.id,...who,
              label:`${who.catName ?? '猫猫'}这次没完成${message.content.trim() ? '：'+message.content.trim().slice(0, 160) : ''}`});
          }
        } else {
          if (!Array.isArray(data.items)) throw new Error('approvals unavailable');
          for (const raw of data.items) {
            const item = record(raw), nav = record(item.navigation), card = record(nav.approvalCardRef);
            if (item.resolution !== 'open' || nav.state !== 'anchored' || card.threadId !== threadId
              || typeof card.messageId !== 'string' || typeof item.proposalId !== 'string') continue;
            view.items.push({id:`approval:${item.sourceFeatureId}:${item.proposalId}`,kind:'approval',threadId,
              messageId:card.messageId,proposalId:item.proposalId,...annotate(item.requesterCatId),
              label:typeof item.summary === 'string' && item.summary.trim() ? `等你确认：${item.summary.slice(0,160)}` : '等你确认'});
          }
        }
        ready++;
      } catch { view.errors.push({source:sources[index]!,message:'暂时无法确认进度，请重试'}); }
    }
    view.items = [...new Map(view.items.map(item => [item.id,item])).values()].sort((a,b)=>rank[a.kind]-rank[b.kind]);
    for (const item of view.items) view.counts[item.kind]++;
    view.readStatus = ready === inputs.length ? 'ready' : ready ? 'partial' : 'unavailable';
    return view;
  }
  async acknowledge(threadId: string, messageId: string, stillCurrent: () => boolean) {
    await this.bridge.thread(threadId);
    const message = this.visibleReplies(threadId, await this.bridge.allMessages(threadId)).find(item => item.id === messageId);
    if (!message) throw new ApiError(404, '这条可见回复不属于当前对话');
    if (!stillCurrent()) throw new ApiError(409, '会话已变化，请刷新后重试');
    if (!Number.isFinite(orderTime(message))) throw new ApiError(502, '消息顺序暂时不可确认');
    const current = this.bridge.store.state.readCursors[threadId];
    if (after(message, current)) {
      this.bridge.store.state.readCursors[threadId] = {messageId,orderTime:orderTime(message)};
      this.bridge.store.save();
    }
    return {threadId,readMessageId:this.bridge.store.state.readCursors[threadId]?.messageId ?? messageId};
  }
}
