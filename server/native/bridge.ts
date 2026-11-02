import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../errors.js';
import { ProductStore } from '../product-store.js';
import type { NativeCat, NativeMessage, NativeThread, NativeTransport } from './types.js';
import { runtimeUnavailable, supportsRuntime } from './agents.js';
import { messagePresentation } from './message-presentation.js';

export const encode = encodeURIComponent;
export interface NativeRuntime {
  id: string; label: string; clientId: string; installed: boolean; configuredModel?: string; models: string[];
  command?: string; configuredEffort?: string;
  readiness?: { status: 'configured' | 'login_required' | 'unknown' | 'not_installed'; checkedAt?: number; loginCommand?: string };
  acp?: Record<string, unknown>; agyCarrier?: string; transport?: string;
}
export interface QueueView {
  queue: Array<{ id: string; status: string; targetCats?: string[]; targetCatId?: string; content?: string; message?: string; [key: string]: unknown }>;
  activeInvocations: Array<{ catId: string; invocationId?: string; startedAt?: number; status?: string; [key: string]: unknown }>;
  queueRevision?: number;
}
export interface RoleTemplate { id: string; name: string; nickname?: string; roleDescription: string; personality?: string; teamStrengths?: string; color: { primary: string; secondary: string } }
export interface CreateBot { name: string; persona?: string; description?: string; avatar_seed?: string; templateId?: string; timezone?: string; runtimeId?: string }

export class BotBridge {
  private directCreates = new Map<string, Promise<NativeThread>>();
  constructor(readonly native: NativeTransport, readonly store: ProductStore, readonly workspace: string) {}
  cats(): Promise<NativeCat[]> { return this.native.request<{ cats: NativeCat[] }>('/api/cats').then(r => r.cats); }
  templates(): Promise<{ templates: RoleTemplate[]; clientDefaults: Record<string, { defaultModel: string; models: string[] }> }> { return this.native.request('/api/cat-templates'); }
  runtimes(refresh = false): Promise<NativeRuntime[]> { return this.native.request<{ runtimes: NativeRuntime[] }>(`/api/cats/native-runtimes${refresh ? '?refresh=1' : ''}`).then(r => r.runtimes); }
  async cat(name: string): Promise<NativeCat> {
    const cat = (await this.cats()).find(c => c.name === name || c.id === name);
    if (!cat) throw new ApiError(404, '找不到这个 Bot');
    return cat;
  }
  botItem(cat: NativeCat) {
    const meta = this.store.bot(cat.id);
    return { id: cat.id, name: cat.name, templateId: meta.templateId ?? cat.breedId ?? 'ragdoll', persona: cat.roleDescription.slice(0, 80),
      description: cat.teamStrengths ?? '', unread: 0, notes: 0, pinned: !!meta.pinned,
      primary: cat.isDefaultResponder === true, group: meta.folder ?? '', avatar: meta.avatarData ? 'custom' : 'generated',
      avatar_seed: meta.avatarSeed ?? `cat:${meta.templateId ?? cat.breedId ?? 'ragdoll'}`,
      avatar_url: meta.avatarData ? `/xbot-api/bots/${encode(cat.name)}/avatar?v=${meta.avatarUpdated}` : '',
      thread_id: meta.activeThreadId, native_id: cat.id };
  }
  thread(id: string): Promise<NativeThread> { return this.native.request(`/api/threads/${encode(id)}`); }
  async direct(cat: NativeCat): Promise<NativeThread> {
    const id = this.store.bot(cat.id).activeThreadId;
    if (id) return this.thread(id);
    const pending = this.directCreates.get(cat.id);
    if (pending) return pending;
    const uuid = createHash('sha256').update(`bot-initial-thread:${cat.id}`).digest('hex').slice(0, 32);
    const key = `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-4${uuid.slice(13, 16)}-8${uuid.slice(17, 20)}-${uuid.slice(20)}`;
    const create = this.newThread(cat.name, [cat.id], key).then(thread => {
      this.store.bot(cat.id).activeThreadId = thread.id; this.store.save(); return thread;
    });
    this.directCreates.set(cat.id, create);
    try { return await create; } finally { this.directCreates.delete(cat.id); }
  }
  newThread(title: string, members: string[], idempotencyKey: string = randomUUID()): Promise<NativeThread> {
    return this.native.request('/api/threads', { method: 'POST', body: { title, preferredCats: members, projectPath: this.workspace, idempotencyKey } });
  }
  async group(id: string): Promise<NativeThread> {
    if (!this.store.state.groupThreadIds.includes(id)) throw new ApiError(404, '找不到这个群聊');
    return this.thread(id);
  }
  groupItem(thread: NativeThread, cats: NativeCat[]) {
    return { id: thread.id, name: thread.title ?? '群聊', members: (thread.preferredCats ?? []).map(id => cats.find(c => c.id === id)?.name ?? id),
      created: new Date(thread.createdAt).toISOString(), native_thread_id: thread.id };
  }
  async messages(threadId: string, before?: string) {
    return this.native.request<{ messages: NativeMessage[]; hasMore: boolean }>(`/api/messages?${new URLSearchParams({ threadId, limit: '200', ...(before ? { before } : {}) })}`);
  }
  async allMessages(threadId: string): Promise<NativeMessage[]> {
    const pages: NativeMessage[][] = [], seen = new Set<string>();
    let before: string | undefined;
    for (;;) {
      const page = await this.messages(threadId, before);
      pages.push(page.messages);
      if (!page.hasMore) break;
      const first = page.messages[0];
      if (!first) throw new ApiError(502, '原生消息分页返回了空游标');
      before = `${first.timelineOrderAt ?? first.timestamp}:${first.id}`;
      if (seen.has(before)) throw new ApiError(502, '原生消息分页没有前进');
      seen.add(before);
    }
    return [...new Map(pages.reverse().flat().map(m => [m.id, m])).values()];
  }
  async transcript(cat: NativeCat, before?: string) {
    const thread = await this.direct(cat);
    const [page, cats] = await Promise.all([this.messages(thread.id, before), this.cats()]);
    const rows: Record<string, unknown>[] = [];
    for (const message of page.messages) this.store.sequence(thread.id, message.id);
    for (const { message, ...presentation } of this.presentMessages(page.messages, cats)) {
      const seq = this.store.sequence(thread.id, message.id);
      const pending = message.isDraft || ['queued', 'processing'].includes(message.lifecycle?.status ?? '');
      const text = message.content || (pending ? '正在等待或处理…' : message.lifecycle?.status === 'canceled' ? '已停止' : '');
      const base = { seq, id: message.id, native_message_id: message.id, role: message.type === 'user' ? 'user' : 'assistant',
        content: text, ...presentation, time: new Date(message.timestamp).toISOString(),
        reply_to: message.replyTo ? this.store.state.messageRefs[thread.id]?.[message.replyTo] ?? 0 : 0,
        status: message.lifecycle?.status ?? (message.isDraft ? 'processing' : 'complete'), native: message };
      if (message.type === 'user' || presentation.presentation_kind === 'activity') rows.push(base);
      else if (text) {
        // XBot's delivery view. These receipts describe rendering, never model tool execution.
        const callId = `delivery_${message.id}`;
        rows.push({ ...base, presentation_receipt: true, tool_calls: [{ id: callId, type: 'function', function: { name: 'send_message_to_user', arguments: JSON.stringify({ text }) } }] });
        rows.push({ seq: seq + 1, role: 'tool', name: 'send_message_to_user', content: "sent to the owner's chat", tool_call_id: callId, presentation_receipt: true, time: base.time });
      }
    }
    this.store.bot(cat.id).lastReadMessageId = page.messages.at(-1)?.id;
    this.store.save();
    const first = page.messages[0];
    return { messages: rows, hasMore: page.hasMore, before: first ? `${first.timelineOrderAt ?? first.timestamp}:${first.id}` : null, thread_id: thread.id };
  }
  presentMessages(messages: NativeMessage[], cats: NativeCat[]) {
    const kinds = messagePresentation(messages);
    return messages.map(message => {
      const sender = cats.find(cat => cat.id === message.catId);
      const item = sender ? this.botItem(sender) : undefined;
      const speaker = item ? { id: item.id, name: item.name, templateId: item.templateId,
        avatar: item.avatar, avatar_seed: item.avatar_seed, avatar_url: item.avatar_url } : null;
      return { message, presentation_kind: kinds.get(message.id)!, speaker, native_cat_id: message.catId,
        name: sender?.name ?? message.catId ?? '系统' };
    });
  }
  queue(threadId: string): Promise<QueueView> { return this.native.request(`/api/threads/${encode(threadId)}/queue`); }
  async statuses() {
    const cats = await this.cats();
    const ids = new Set([...this.store.state.groupThreadIds, ...Object.values(this.store.state.bots).flatMap(b => b.activeThreadId ? [b.activeThreadId] : [])]);
    const queues = await Promise.all([...ids].map(async id => ({ threadId: id, ...(await this.queue(id)) })));
    return { bots: cats.map(cat => {
      const active = queues.flatMap(q => q.activeInvocations.filter(i => i.catId === cat.id).map(i => ({ ...i, threadId: q.threadId })));
      const queued = queues.flatMap(q => q.queue.filter(e => e.targetCatId === cat.id || e.targetCats?.includes(cat.id)).map(e => ({ ...e, threadId: q.threadId })));
      return { bot: cat.name, native_id: cat.id, state: active.length ? 'running' : queued.length ? 'queued' : 'idle',
        since: active[0]?.startedAt ? new Date(active[0].startedAt).toISOString() : undefined,
        task: active.length ? 'Clowder AI 正在执行' : queued.length ? 'Clowder AI 队列等待中' : '', todo: '', tool: '', tool_summary: '', completed_unread: 0,
        active, queued };
    }), others: [] };
  }
  async createBot(input: CreateBot, source?: NativeCat) {
    if ((await this.cats()).some(c => c.name.toLowerCase() === input.name.toLowerCase())) throw new ApiError(409, '已有同名 Bot');
    const templates = await this.templates();
    const requestedTemplate = input.templateId ?? (source ? this.store.bot(source.id).templateId : undefined) ?? 'ragdoll';
    const template = templates.templates.find(t => t.id === requestedTemplate);
    if (!template) throw new ApiError(503, '上游角色模板不可用');
    const runtimes = await this.runtimes();
    const installed = runtimes.filter(r => r.installed && supportsRuntime(r) && !runtimeUnavailable(r));
    const runtime = input.runtimeId ? runtimes.find(r => r.id === input.runtimeId) : source ? installed.find(r => r.clientId === source.clientId) : installed.find(r => r.readiness?.status === 'configured') ?? installed[0];
    if (!runtime) throw new ApiError(422, '请先安装并配置本地 Agent，再选择接入。');
    const unavailable = runtimeUnavailable(runtime);
    if (unavailable) throw new ApiError(422, unavailable);
    const catId = `bot-${randomUUID().slice(0, 12)}`;
    const { cat } = await this.native.request<{ cat: NativeCat }>('/api/cats', { method: 'POST', body: {
      catId, name: input.name, displayName: input.name, nickname: input.name,
      color: template.color, mentionPatterns: [`@${input.name}`, `@${catId}`],
      roleDescription: input.persona?.trim() || source?.roleDescription || template.roleDescription,
      personality: source?.personality ?? template.personality,
      teamStrengths: input.description ?? source?.teamStrengths ?? template.teamStrengths,
      clientId: runtime.clientId, configurationSource: 'native_tool', defaultModel: '',
    } });
    Object.assign(this.store.bot(cat.id), { templateId: template.id, avatarSeed: input.avatar_seed, timezone: input.timezone });
    this.store.save();
    return cat;
  }
  async send(thread: NativeThread, body: { text: string; reply_to?: number; idempotencyKey?: string }, directCat?: NativeCat) {
    const replyTo = body.reply_to ? this.store.messageId(thread.id, body.reply_to) : undefined;
    if (body.reply_to && !replyTo) throw new ApiError(400, '引用的消息不存在，请刷新会话');
    return this.native.request('/api/messages', { method: 'POST', body: {
      threadId: thread.id, content: body.text, idempotencyKey: body.idempotencyKey ?? randomUUID(),
      // Native admission binds the exact active parent and appends without interrupting.
      // If the carrier cannot append (or is idle), native Queue safely starts the next turn.
      // Do not inspect a stale busy snapshot or issue a second force/steer request here.
      messageDisposition: 'continue_current',
      ...(directCat ? { mentions: [directCat.id] } : {}), ...(replyTo ? { replyTo } : {}),
    } });
  }
  async stop(threadId: string, catId?: string) {
    const queue = await this.queue(threadId);
    // Withdrawal and active cancellation use native APIs and remain separately observable.
    if (!catId) await this.native.request(`/api/threads/${encode(threadId)}/queue`, { method: 'DELETE' });
    else for (const entry of queue.queue) {
      if (entry.status !== 'processing' && (entry.targetCatId === catId || entry.targetCats?.includes(catId))) {
        if (entry.targetCats && (entry.targetCats.length !== 1 || entry.targetCats[0] !== catId)) throw new ApiError(409, '该队列项包含其他成员，请在运行面板按队列项撤回');
        if (typeof entry.messageId !== 'string') throw new ApiError(409, '该队列项缺少原生来源，无法安全撤回');
        const exact = new URLSearchParams({ expectedSourceMessageId: entry.messageId, expectedTargetCatId: catId });
        await this.native.request(`/api/threads/${encode(threadId)}/queue/${encode(entry.id)}?${exact}`, { method: 'DELETE' });
      }
    }
    // A queued item can become active while withdrawal is in flight.
    const afterWithdrawal = await this.queue(threadId);
    const activeCats = new Set([...queue.activeInvocations, ...afterWithdrawal.activeInvocations].filter(i => !catId || i.catId === catId).map(i => i.catId));
    for (const id of activeCats) {
      try { await this.native.request(`/api/threads/${encode(threadId)}/cancel/${encode(id)}`, { method: 'POST', body: {} }); }
      catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e; }
    }
    return { status: 'ok', native: await this.queue(threadId) };
  }
  async notes(threadId: string) {
    const { entries } = await this.native.request<{ entries: Array<{ key: string; value: string; updatedAt?: number }> }>(`/api/memory?threadId=${encode(threadId)}`);
    return entries.map(e => ({ id: e.key, scope: 'conversation', text: e.value, native: e }));
  }
}
