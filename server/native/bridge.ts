import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../errors.js';
import { ProductStore } from '../product-store.js';
import type { NativeCat, NativeMessage, NativeThread, NativeTransport } from './types.js';
import { runtimeUnavailable, supportsRuntime } from './agents.js';
import { messageDisplayText, messagePresentation } from './message-presentation.js';
import { avatarBreed, type CatConfig, type SourceTemplate } from './cat-templates.js';
import { Workspaces } from '../workspaces.js';
import { NativeFiles } from './files.js';
import { Activity } from './activity.js';

export const encode = encodeURIComponent;
// A regular conversation request. The native member receives its own name, role
// and personality through Clowder AI's identity context, just as on later turns.
const greetingInvitation = [
  '聊天页的开场邀请：用一两句自然的中文和刚见面的人打个招呼。人设只用来拿捏语气，不主动讲职业、身世或场景，也不要据此猜对方想做什么。',
  '只有你的名字本身直接说出了要做的事，才顺着那件事问一个简短、开放的问题，由对方决定方向。不要预设对方已有材料、需求或偏好。',
  '遇到人名、昵称、意象、仅仅是个话题，或者拿不准时，只问好就收住。可以报自己的名字，不解读名字，不追问，也不邀请对方进入某个情境。只写问候正文，无需署名。',
].join('\n');
// Native admission checks the original content on replay. Only receipts that
// were already pending under the old wording (stored as null) use this text.
const legacyGreetingInvitation = '聊天页的开场邀请：请用符合你名字和人设的口吻，用一两句自然的中文和刚见面的用户打个招呼。名字明显表达了用途时，就顺着问一个具体的小问题，不必介绍或承诺功能；普通昵称只要问好。只写给对方看的问候正文，无需署名，这次只聊天。';

function requestUuid(seed: string) {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}
type GreetingAdmission = { status: 'accepted' | 'exists' };
const greetingKey = (catId: string, threadId: string) => requestUuid(`bot-greeting:${catId}:${threadId}`);
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
export interface CreateBot { name: string; persona?: string; description?: string; avatar_seed?: string; templateId?: string; timezone?: string; runtimeId?: string;
  catConfig?: CatConfig; sourceTemplate?: { id: string; revision: number }; idempotencyKey?: string }

export class BotBridge {
  private directCreates = new Map<string, Promise<NativeThread>>();
  private greetingRequests = new Map<string, Promise<GreetingAdmission>>();
  readonly workspaces: Workspaces;
  readonly nativeFiles: NativeFiles;
  readonly activity: Activity;
  constructor(readonly native: NativeTransport, readonly store: ProductStore, readonly workspace: string) {
    this.workspaces = new Workspaces(this); this.nativeFiles = new NativeFiles(this); this.activity = new Activity(this);
  }
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
      thread_id: meta.activeThreadId, native_id: cat.id, project_id: meta.projectId ?? null };
  }
  thread(id: string): Promise<NativeThread> { return this.native.request(`/api/threads/${encode(id)}`); }
  async direct(cat: NativeCat): Promise<NativeThread> {
    const id = this.store.bot(cat.id).activeThreadId;
    if (id) return this.thread(id);
    const pending = this.directCreates.get(cat.id);
    if (pending) return pending;
    const key = requestUuid(`bot-initial-thread:${cat.id}`);
    const create = this.workspaces.catPath(cat.id).then(path => this.newThread(cat.name, [cat.id], key, path)).then(thread => {
      const meta = this.store.bot(cat.id);
      meta.activeThreadId = thread.id; meta.conversationIds = [...new Set([...(meta.conversationIds ?? []), thread.id])];
      this.store.save(); return thread;
    });
    this.directCreates.set(cat.id, create);
    try { return await create; } finally { this.directCreates.delete(cat.id); }
  }
  newThread(title: string, members: string[], idempotencyKey: string = randomUUID(), projectPath = this.workspace): Promise<NativeThread> {
    return this.native.request('/api/threads', { method: 'POST', body: { title, preferredCats: members, projectPath, idempotencyKey } });
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
    // A poll can see the native invitation before the simultaneous POST has
    // returned its source ID. Only project a hidden source from a real receipt.
    if (page.messages.some(message => message.type === 'user'))
      await this.greetingRequests.get(greetingKey(cat.id, thread.id))?.catch(() => {});
    const invitation = this.store.bot(cat.id).greetingSources?.[thread.id];
    const source = typeof invitation === 'string' ? invitation : undefined;
    const rows: Record<string, unknown>[] = [];
    for (const message of page.messages) this.store.sequence(thread.id, message.id);
    for (const { message, ...presentation } of this.presentMessages(page.messages, cats)) {
      if (message.type === 'user' && message.id === source) continue;
      const seq = this.store.sequence(thread.id, message.id);
      const text = messageDisplayText(message);
      const base = { seq, id: message.id, native_message_id: message.id, role: message.type === 'user' ? 'user' : 'assistant',
        content: text, ...presentation, time: new Date(message.timestamp).toISOString(),
        reply_to: message.replyTo && message.replyTo !== source ? this.store.state.messageRefs[thread.id]?.[message.replyTo] ?? 0 : 0,
        status: message.lifecycle?.status ?? (message.isDraft ? 'processing' : 'complete'), attachments: this.workspaces.messageFiles(thread.id, message), native: message };
      if (message.type === 'user' || presentation.presentation_kind === 'activity') rows.push(base);
      else if (text || base.attachments.length) {
        // XBot's delivery view. These receipts describe rendering, never model tool execution.
        const callId = `delivery_${message.id}`;
        rows.push({ ...base, presentation_receipt: true, tool_calls: [{ id: callId, type: 'function', function: { name: 'send_message_to_user', arguments: JSON.stringify({ text }) } }] });
        rows.push({ seq: seq + 1, role: 'tool', name: 'send_message_to_user', content: "sent to the owner's chat", tool_call_id: callId, presentation_receipt: true, time: base.time });
      }
    }
    this.store.save();
    const first = page.messages[0];
    return { messages: rows, hasMore: page.hasMore, before: first ? `${first.timelineOrderAt ?? first.timestamp}:${first.id}` : null, thread_id: thread.id,
      ...(invitation !== undefined ? { greeting: source ? { status: 'accepted', sourceMessageId: source } : { status: 'unconfirmed' } } : {}) };
  }
  async greet(cat: NativeCat, threadId: string): Promise<GreetingAdmission> {
    const meta = this.store.bot(cat.id);
    if (meta.activeThreadId !== threadId) throw new ApiError(409, '对话已切换，请重新打开');
    const key = greetingKey(cat.id, threadId);
    const inFlight = this.greetingRequests.get(key);
    if (inFlight) return inFlight;
    const invite = async (): Promise<GreetingAdmission> => {
      // The native read enforces access even when a previous request has a receipt.
      const page = await this.messages(threadId);
      const known = meta.greetingSources?.[threadId];
      if (typeof known === 'string') return { status: 'accepted' };
      if (known === undefined) {
        if (page.messages.length || page.hasMore) return { status: 'exists' };
        // Admission can precede publication. A real first turn already in the
        // native Queue also counts as a conversation that has started.
        const work = await this.queue(threadId);
        if (work.activeInvocations.length || work.queue.length) return { status: 'exists' };
      }
      if (meta.activeThreadId !== threadId) throw new ApiError(409, '对话已切换，请重新打开');
      // Record only that this empty chat requested an opening. An uncertain
      // POST may already have landed. Explicit recovery reuses the same native
      // idempotency key instead of running the cat a second time.
      const sources = meta.greetingSources ??= {};
      const pending = known === undefined ? { invitationVersion: 2 as const } : known;
      if (known === undefined) {
        sources[threadId] = pending;
        try { this.store.save(); } catch (error) { delete sources[threadId]; throw error; }
      }
      const receipt = await this.native.request('/api/messages', { method: 'POST', body: {
        content: pending === null ? legacyGreetingInvitation : greetingInvitation, threadId, mentions: [cat.id], messageDisposition: 'next_work',
        idempotencyKey: key,
      } }).catch(error => {
        // These native refusals happen before admission. On an uncertain
        // earlier attempt, only a receipt can resolve the original request.
        if (known === undefined && error instanceof ApiError && [400, 401, 403, 404, 429].includes(error.status)) {
          delete sources[threadId];
          this.store.save();
        }
        throw error;
      });
      if (typeof receipt?.userMessageId !== 'string' || !receipt.userMessageId)
        throw new ApiError(502, '尚未确认开场邀请是否送达，可以重试');
      sources[threadId] = receipt.userMessageId;
      try { this.store.save(); } catch (error) { sources[threadId] = pending; throw error; }
      return { status: 'accepted' };
    };
    const request = invite();
    this.greetingRequests.set(key, request);
    try { return await request; } finally { this.greetingRequests.delete(key); }
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
    const ids = new Set([...this.store.state.groupThreadIds, ...Object.values(this.store.state.bots).flatMap(b => [...(b.activeThreadId ? [b.activeThreadId] : []), ...(b.conversationIds ?? []), ...Object.values(b.workspaceThreads ?? {})])]);
    // One owner approval read per status refresh, shared across the thread projections.
    const pending = this.activity.approvals(); void pending.catch(() => {});
    const views = await Promise.all([...ids].map(async id => {
      try { return await this.activity.read(id, cats, pending); }
      catch { return this.activity.unavailable(id); }
    }));
    return { bots: cats.map(cat => {
      const threadId = this.store.bot(cat.id).activeThreadId;
      const activity = threadId ? views.find(view => view.threadId === threadId) ?? this.activity.unavailable(threadId) : undefined;
      const active = views.flatMap(view => view.active.filter(i => i.catId === cat.id).map(i => ({ ...i, threadId: view.threadId })));
      const queued = views.flatMap(view => view.queued.filter(e => e.targetCatId === cat.id || e.targetCats?.includes(cat.id)).map(e => ({ ...e, threadId: view.threadId })));
      return { bot: cat.name, native_id: cat.id, thread_id: threadId, activity,
        executionReadStatus: views.some(view => view.errors.some(error => error.source === 'queue' || error.source === 'thread')) ? 'unavailable' : 'ready',
        state: activity?.counts.approval ? 'awaiting' : active.length ? 'running' : queued.some(q => ['queued','pending'].includes(q.status)) ? 'queued' : activity && activity.readStatus !== 'ready' ? 'unknown' : 'idle',
        since: active[0]?.startedAt ? new Date(active[0].startedAt).toISOString() : undefined,
        task: active.length ? '正在处理' : queued.length ? '消息排队中' : '', todo: '', tool: '', tool_summary: '',
        unread: activity?.unread ?? null, completed_unread: activity?.unread ?? null,
        active, queued };
    }), groups: this.store.state.groupThreadIds.map(id => ({id,thread_id:id,activity:views.find(view => view.threadId === id) ?? this.activity.unavailable(id)})), others: [] };
  }
  async createBot(input: CreateBot, source?: NativeCat) {
    if (input.catConfig) {
      if (source || input.runtimeId || input.templateId || input.persona !== undefined || input.description !== undefined)
        throw new ApiError(400, '创建配置不能与旧版字段混用');
      const result = await this.native.request<{ cat: NativeCat; sourceTemplate: SourceTemplate | null }>('/api/bot-cat-templates/instantiate', {
        method: 'POST', body: { name: input.name, catConfig: input.catConfig,
          ...(input.sourceTemplate ? { sourceTemplate: input.sourceTemplate } : {}), idempotencyKey: input.idempotencyKey ?? randomUUID() },
      });
      const cat = result.cat;
      if (!cat?.id || !cat.breedId) throw new ApiError(502, '原生创建结果缺少猫猫身份');
      const identity = avatarBreed(cat.breedId);
      Object.assign(this.store.bot(cat.id), { templateId: identity, avatarSeed: input.avatar_seed || `cat:${identity}`,
        timezone: input.timezone, ...(result.sourceTemplate ? { sourceTemplate: result.sourceTemplate } : {}) });
      this.store.save();
      return cat;
    }
    if (input.sourceTemplate) throw new ApiError(400, '缺少创建配置');
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
  async send(thread: NativeThread, body: { text: string; reply_to?: number; idempotencyKey?: string; attachments?: string[]; expectedThreadId?: string }, directCat?: NativeCat) {
    if (body.expectedThreadId && body.expectedThreadId !== thread.id) throw new ApiError(409, '会话已变化，请核对后重试');
    if (body.attachments?.length && !body.expectedThreadId) throw new ApiError(400, '发送附件需要当前会话标识');
    const attachments = body.attachments?.length ? await this.workspaces.attachments(thread.id, body.attachments) : [];
    const replyTo = body.reply_to ? this.store.messageId(thread.id, body.reply_to) : undefined;
    if (body.reply_to && !replyTo) throw new ApiError(400, '引用的消息不存在，请刷新会话');
    return this.native.request('/api/messages', { method: 'POST', body: {
      threadId: thread.id, content: body.text, idempotencyKey: body.idempotencyKey ?? randomUUID(),
      // Native admission binds the exact active parent and appends without interrupting.
      // If the carrier cannot append (or is idle), native Queue safely starts the next turn.
      // Do not inspect a stale busy snapshot or issue a second force/steer request here.
      messageDisposition: 'continue_current',
      ...(attachments.length ? { contextAttachments: attachments } : {}),
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
