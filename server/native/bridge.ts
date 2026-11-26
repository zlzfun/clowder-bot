import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../errors.js';
import { ProductStore } from '../product-store.js';
import type { NativeCat, NativeMessage, NativeThread, NativeTransport } from './types.js';
import { defaultRuntime, faceOfTool, faceTool, faceTools, memberCliArgs, runtimeUnavailable, supportsRuntime, faceTemplates, type Face, type FaceTemplate } from './agents.js';
import { approvalReceipt, approvalReceiptText, messageDisplayText, messagePresentation, replyEnding, replyInProgress, rosterRefusals, scheduledReminder } from './message-presentation.js';
import { avatarBreed, type CatConfig, type SourceTemplate } from './cat-templates.js';
import { clip } from './text.js';
import { cardReceipts, messageBlocks, type ApprovalDecision } from './blocks.js';
import { Workspaces } from '../workspaces.js';
import { NativeFiles } from './files.js';
import { Activity } from './activity.js';
import { Approvals } from './approvals.js';
import { ChatPack } from './chat-pack.js';
import { PageReading, soleEmoji } from './reactions.js';
import { Computer, noComputer, type ComputerDriver } from './computer.js';

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
  catConfig?: CatConfig; sourceTemplate?: { id: string; revision: number }; idempotencyKey?: string;
  /**
   * A name and, optionally, a face. The face is one of the engine's cat templates: the cat starts with that
   * template's role, personality and strengths. With `custom` (or words of the owner's own in `about` /
   * `personality`) the face only gives the looks and the portrait is the owner's, or a plain helper's.
   */
  simple?: { face?: string; rev?: string; custom?: true; about?: string; personality?: string; agent?: string } }
// The role a cat gets when the owner only named it. The owner can change it later in the cat's profile.
const defaultRole = '随叫随到的伙伴：聊天、答疑、查资料、写东西、整理文件，交代的事会动手做完。说话自然简洁，先给结果，拿不准的地方再问。';
// A custom cat without words of the owner's own is a plain helper; said explicitly so native does not fill in a breed's stock portrait.
const defaultPersonality = '亲切耐心，讲得清楚；做事利落，不绕弯子。';
const defaultStrengths = '聊天答疑、查资料、写东西、整理文件';
const hex = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
/** Only a well-formed colour pair is passed on; the value ends up in a style. */
const accent = (cat: NativeCat) => hex(cat.color?.primary) && hex(cat.color?.secondary) ? { primary: cat.color.primary, secondary: cat.color.secondary } : undefined;

export class BotBridge {
  private directCreates = new Map<string, Promise<NativeThread>>();
  private greetingRequests = new Map<string, Promise<GreetingAdmission>>();
  /** Whom a group reply was addressed to, by conversation and the request's idempotency key (see answeredCat). Request bookkeeping, in memory. */
  private addressedReplies = new Map<string, Promise<string | undefined>>();
  readonly workspaces: Workspaces;
  readonly nativeFiles: NativeFiles;
  readonly activity: Activity;
  readonly approvals: Approvals;
  /** The engine pack that makes every cat talk the way a chat is talked in; asked for before a cat is given something to answer. */
  readonly manner: ChatPack;
  /** Which cats may use this computer (the engine's registry) and the driver behind it. Without a driver the feature is absent. */
  readonly computer: Computer;
  /** What the owner should hear about a cat that was just created, by cat, until it is said (see createBot). Request bookkeeping, in memory. */
  private readonly creationNotices = new Map<string, string>();
  constructor(readonly native: NativeTransport, readonly store: ProductStore, readonly workspace: string, driver: ComputerDriver = noComputer) {
    this.workspaces = new Workspaces(this); this.nativeFiles = new NativeFiles(this); this.activity = new Activity(this);
    this.approvals = new Approvals(this); this.manner = new ChatPack(native); this.computer = new Computer(native, driver);
  }
  cats(): Promise<NativeCat[]> { return this.native.request<{ cats: NativeCat[] }>('/api/cats').then(r => r.cats); }
  templates(): Promise<{ templates: RoleTemplate[]; clientDefaults: Record<string, { defaultModel: string; models: string[] }> }> { return this.native.request('/api/cat-templates'); }
  /** The engine's templates as faces are made from them, with malformed entries left out (see faceTemplates). */
  faceTemplates(): Promise<FaceTemplate[]> { return this.native.request('/api/cat-templates').then(faceTemplates); }
  /** Creation requests in flight or just made, by their key: what was asked and the engine request it resolved to. Not persisted. */
  private readonly simpleRequests = new Map<string, { input: string; body: Record<string, unknown>; face: string; tool: string }>();
  /** The resolutions of those requests that are still being worked out, so that identical requests arriving together share one. */
  private readonly simpleResolving = new Map<string, Promise<{ input: string; body: Record<string, unknown>; face: string; tool: string }>>();
  runtimes(refresh = false): Promise<NativeRuntime[]> { return this.native.request<{ runtimes: NativeRuntime[] }>(`/api/cats/native-runtimes${refresh ? '?refresh=1' : ''}`).then(r => r.runtimes); }
  async cat(name: string): Promise<NativeCat> {
    const cat = (await this.cats()).find(c => c.name === name || c.id === name);
    if (!cat) throw new ApiError(404, '找不到这只猫猫');
    return cat;
  }
  botItem(cat: NativeCat) {
    const meta = this.store.bot(cat.id);
    return { id: cat.id, name: cat.name, templateId: meta.templateId ?? cat.breedId ?? 'ragdoll', persona: cat.roleDescription.slice(0, 80),
      description: cat.teamStrengths ?? '', unread: 0, notes: 0, pinned: !!meta.pinned,
      primary: cat.isDefaultResponder === true, group: meta.folder ?? '', avatar: meta.avatarData ? 'custom' : 'generated',
      avatar_seed: meta.avatarSeed ?? `cat:${meta.templateId ?? cat.breedId ?? 'ragdoll'}`,
      avatar_url: meta.avatarData ? `/xbot-api/bots/${encode(cat.name)}/avatar?v=${meta.avatarUpdated}` : '',
      // The cat's own native colour pair, for a quiet accent in its chat.
      ...(accent(cat) ? { accent: accent(cat) } : {}),
      thread_id: meta.activeThreadId, native_id: cat.id, project_id: meta.projectId ?? null };
  }
  /**
   * Whether a user message is the opening invitation the app sent on the owner's
   * behalf. Known by its native ID once the receipt is in; while the receipt
   * is still pending, by the exact wording in that conversation.
   */
  isInvitation(threadId: string, message: NativeMessage): boolean {
    if (message.type !== 'user') return false;
    for (const bot of Object.values(this.store.state.bots)) {
      const source = bot.greetingSources?.[threadId];
      if (source === undefined) continue;
      if (typeof source === 'string' ? source === message.id : [greetingInvitation, legacyGreetingInvitation].includes(message.content)) return true;
    }
    return false;
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
      if (!first) throw new ApiError(502, '引擎的消息分页返回了空游标');
      before = `${first.timelineOrderAt ?? first.timestamp}:${first.id}`;
      if (seen.has(before)) throw new ApiError(502, '引擎的消息分页没有前进');
      seen.add(before);
    }
    return [...new Map(pages.reverse().flat().map(m => [m.id, m])).values()];
  }
  /** `reactions`: the reader draws reactions (see PageReading); without it every message is the line it is. */
  async transcript(cat: NativeCat, before?: string, view: { reactions?: boolean } = {}) {
    const thread = await this.direct(cat);
    const [page, cats] = await Promise.all([this.messages(thread.id, before), this.cats()]);
    // A poll can see the native invitation before the simultaneous POST has
    // returned its source ID. Only project a hidden source from a real receipt.
    if (page.messages.some(message => message.type === 'user'))
      await this.greetingRequests.get(greetingKey(cat.id, thread.id))?.catch(() => {});
    const invitation = this.store.bot(cat.id).greetingSources?.[thread.id];
    const source = typeof invitation === 'string' ? invitation : undefined;
    const rows: Record<string, unknown>[] = [], known = this.store.references;
    for (const message of page.messages) this.store.sequence(thread.id, message.id);
    // What each row quotes, and which messages are drawn on another row as a reaction (see PageReading).
    const reading = new PageReading({ hasMore: page.hasMore, invitation: source, reactions: view.reactions });
    const drawn = new Map<string, Record<string, unknown>>();
    // A cat that was addressed but does not belong to this conversation: said once by name (see rosterRefusals).
    const refusals = rosterRefusals(page.messages, id => cats.find(cat => cat.id === id)?.name, false);
    const decided = this.decisions(page.messages), onCards = this.receiptsOnCards(page.messages);
    for (const { message, ...presentation } of this.presentMessages(page.messages, cats)) {
      if (message.type === 'user' && message.id === source) continue;
      if (refusals.get(message.id) === null) continue;
      // Its request card, on this page, already says how it was answered.
      if (onCards.has(message.id)) continue;
      const seq = this.store.sequence(thread.id, message.id), receipt = approvalReceipt(message);
      // A reminder that came due is a quiet line in the chat's words; the cat's own reply follows it.
      const reminder = scheduledReminder(message);
      const refusal = refusals.get(message.id) ?? (receipt ? approvalReceiptText(receipt) : reminder ? `提醒：${reminder}` : undefined);
      const text = refusal ?? messageDisplayText(message, thread.id, presentation.speaker?.name), inProgress = replyInProgress(message);
      const rich = message.type === 'user' ? { blocks: [], hidden: 0 } : messageBlocks(message, decided), ending = replyEnding(message);
      const attachments = this.workspaces.messageFiles(thread.id, message), time = new Date(message.timestamp).toISOString();
      // The owner's or a cat's own words and nothing else: what a reaction is made of, and what one can be drawn on.
      const said = !refusal && presentation.presentation_kind === 'message' && (message.type === 'user' || (message.type === 'assistant' && !!message.catId));
      const emoji = said && !inProgress && !ending && !attachments.length && !rich.blocks.length && !rich.hidden ? soleEmoji(text) : undefined;
      if (emoji && message.replyTo && reading.react(message, { id: message.id, seq, reply_to_id: message.replyTo, emoji, time, ...this.reactor(message, presentation.name) })) continue;
      const quoted = reading.quote(message);
      const base = { seq, id: message.id, native_message_id: message.id, role: message.type === 'user' ? 'user' : 'assistant',
        content: text, ...presentation, time,
        reply_to: quoted ? this.store.state.messageRefs[thread.id]?.[quoted] ?? 0 : 0,
        status: message.lifecycle?.status ?? (message.isDraft ? 'processing' : 'complete'), ...(inProgress ? { in_progress: true } : {}),
        ...(ending ? { ended: ending } : {}), ...(refusal ? { notice: true } : {}), ...(reminder ? { reminder: true } : {}),
        attachments,
        // Cards, checklists and choices the cat attached; `blocks_hidden` counts what the chat cannot draw yet.
        ...(rich.blocks.length ? { blocks: rich.blocks } : {}), ...(rich.hidden ? { blocks_hidden: rich.hidden } : {}), native: message };
      let row: Record<string, unknown> | undefined;
      if (message.type === 'user' || presentation.presentation_kind === 'activity') rows.push(row = base);
      // A reply that has started but has no words yet stays as a row: the chat shows it as typing.
      else if (text || base.attachments.length || inProgress || rich.blocks.length || rich.hidden) {
        // XBot's delivery view. These receipts describe rendering, never model tool execution.
        const callId = `delivery_${message.id}`;
        rows.push(row = { ...base, presentation_receipt: true, tool_calls: [{ id: callId, type: 'function', function: { name: 'send_message_to_user', arguments: JSON.stringify({ text }) } }] });
        rows.push({ seq: seq + 1, role: 'tool', name: 'send_message_to_user', content: "sent to the owner's chat", tool_call_id: callId, presentation_receipt: true, time: base.time });
      }
      if (row) drawn.set(message.id, row);
      if (row && said) reading.drawn(message, row);
    }
    // The owner said more while a reply was being written and the engine let the reply take it in: the last such message
    // (see laterInputs). Among the messages that are lines here — a reaction sent meanwhile is drawn on its row, not under it.
    for (const [replyId, inputId] of this.laterInputs(page.messages.filter(message => !reading.folded(message.id)))) {
      const row = drawn.get(replyId);
      if (row) row.follows = this.store.sequence(thread.id, inputId);
    }
    // The chat re-reads the conversation every few seconds; only a read that met new messages has something to save.
    if (this.store.references !== known) this.store.save();
    const first = page.messages[0];
    return { messages: rows, hasMore: page.hasMore, before: first ? `${first.timelineOrderAt ?? first.timestamp}:${first.id}` : null, thread_id: thread.id,
      ...(invitation !== undefined ? { greeting: source ? { status: 'accepted', sourceMessageId: source } : { status: 'unconfirmed' } } : {}) };
  }
  /** Who a reaction is from, as a row says it. */
  reactor(message: NativeMessage, name: string) {
    return message.type === 'user' ? { mine: true } : { mine: false, name, ...(message.catId ? { native_cat_id: message.catId } : {}) };
  }
  /** A group's conversation, one page: the same reading as a cat's own chat (what a row quotes, what is drawn on it as a reaction). */
  async groupTranscript(thread: NativeThread, before?: string, view: { reactions?: boolean } = {}) {
    const [cats, page] = await Promise.all([this.cats(), this.messages(thread.id, before)]);
    const first = page.messages[0], known = this.store.references;
    // A row's number, as in a cat's own chat: what a reply names when it quotes one.
    for (const message of page.messages) this.store.sequence(thread.id, message.id);
    // A cat that was addressed but is not in this group: said once by name instead of the engine's raw refusal lines.
    const refusals = rosterRefusals(page.messages, id => cats.find(cat => cat.id === id)?.name, true), decided = this.decisions(page.messages);
    // A receipt whose request card on this page already says how it was answered is not drawn as a line as well.
    const onCards = this.receiptsOnCards(page.messages);
    const reading = new PageReading({ hasMore: page.hasMore, reactions: view.reactions }), rows: Record<string, unknown>[] = [];
    const drawn = new Map<string, Record<string, unknown>>();
    for (const { message: m, name, ...presentation } of this.presentMessages(page.messages.filter(m => refusals.get(m.id) !== null && !onCards.has(m.id)), cats)) {
      const rich = m.type === 'user' ? { blocks: [], hidden: 0 } : messageBlocks(m, decided), receipt = approvalReceipt(m);
      const reminder = scheduledReminder(m);
      const refusal = refusals.get(m.id) ?? (receipt ? approvalReceiptText(receipt) : reminder ? `提醒：${reminder}` : undefined);
      const text = refusal ?? messageDisplayText(m, thread.id, presentation.speaker?.name), inProgress = replyInProgress(m), ending = replyEnding(m);
      const attachments = this.workspaces.messageFiles(thread.id, m), time = new Date(m.timestamp).toISOString();
      const said = !refusal && presentation.presentation_kind === 'message' && (m.type === 'user' || (m.type === 'assistant' && !!m.catId));
      const emoji = said && !inProgress && !ending && !attachments.length && !rich.blocks.length && !rich.hidden ? soleEmoji(text) : undefined;
      const seq = this.store.sequence(thread.id, m.id);
      if (emoji && m.replyTo && reading.react(m, { id: m.id, seq, reply_to_id: m.replyTo, emoji, time, ...this.reactor(m, name) })) continue;
      const quoted = reading.quote(m);
      // An empty reply that is neither being written nor carries anything is not a line.
      if (m.type === 'assistant' && !text.trim() && !attachments.length && presentation.presentation_kind !== 'activity' && !inProgress && !rich.blocks.length && !rich.hidden) continue;
      const row: Record<string, unknown> = { seq, id: m.id, time, sender: m.type === 'user' ? 'local' : name,
        kind: m.type === 'user' ? 'person' : 'bot', text, ...(refusal ? { notice: true } : {}),
        ...(reminder ? { reminder: true } : {}),
        reply_to: quoted ? this.store.state.messageRefs[thread.id]?.[quoted] ?? 0 : 0,
        status: m.lifecycle?.status ?? (m.isDraft ? 'processing' : 'complete'), ...(inProgress ? { in_progress: true } : {}),
        ...(ending ? { ended: ending } : {}),
        attachments,
        ...(rich.blocks.length ? { blocks: rich.blocks } : {}), ...(rich.hidden ? { blocks_hidden: rich.hidden } : {}), ...presentation, native: m };
      rows.push(row); drawn.set(m.id, row);
      if (said) reading.drawn(m, row);
    }
    // The last message of the owner's that a reply took in after it had begun (by message id here), among those that are lines.
    for (const [replyId, inputId] of this.laterInputs(page.messages.filter(m => !reading.folded(m.id)))) {
      const row = drawn.get(replyId);
      if (row) row.follows = inputId;
    }
    if (this.store.references !== known) this.store.save();
    return { group: this.groupItem(thread, cats), hasMore: page.hasMore,
      // The cursor for the page before this one, as the single-chat transcript gives it.
      before: first ? `${first.timelineOrderAt ?? first.timestamp}:${first.id}` : null, messages: rows };
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
      // The first thing a cat says in a conversation is said the way a chat is talked in, too.
      await this.manner.ready();
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
  /**
   * Replies that took in something the owner said after they had begun, by the engine's own record: a response
   * lists the messages it answers (`lifecycle.inputMessageIds`), a message that was appended to a running reply
   * says on its own record that this reply accepted it (`dispatchRefs[].appendAcceptance`), and such a message
   * comes later in the conversation than the reply itself. Maps the reply to the last such message on the page,
   * so a chat can draw the reply under everything it answers. The order of the records is not changed.
   */
  laterInputs(messages: NativeMessage[]): Map<string, string> {
    const place = new Map(messages.map((message, index) => [message.id, index])), later = new Map<string, string>();
    const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    // The engine lists a message as an input before the tool has confirmed taking it in (appendAcceptance: pending), and
    // keeps it listed when that stayed uncertain. Only a message whose own record says this reply accepted it counts.
    const accepted = (input: NativeMessage, reply: NativeMessage) => (Array.isArray(input.lifecycle?.dispatchRefs) ? input.lifecycle.dispatchRefs as unknown[] : []).map(record)
      .some(ref => ref.appendAcceptance === 'accepted' && ref.statusMessageId === reply.id && (ref.targetId === undefined || ref.targetId === reply.catId));
    for (const [index, message] of messages.entries()) {
      const inputs = message.type === 'assistant' && Array.isArray(message.lifecycle?.inputMessageIds) ? message.lifecycle.inputMessageIds as unknown[] : [];
      const last = inputs.filter((id): id is string => typeof id === 'string' && (place.get(id) ?? -1) > index)
        .map(id => messages[place.get(id)!]!).filter(input => input.type === 'user' && accepted(input, message))
        .sort((a, b) => place.get(a.id)! - place.get(b.id)!).at(-1);
      if (last) later.set(message.id, last.id);
    }
    return later;
  }
  /** How the requests for confirmation on this page were answered, from the engine's own receipts. */
  decisions(messages: NativeMessage[]): ApprovalDecision[] {
    return messages.map(approvalReceipt).filter((receipt): receipt is ApprovalDecision => !!receipt);
  }
  /**
   * The receipts on this page whose request card is on it too and takes its state from them. That card says how it was
   * answered (已记住这个偏好 · …), so the receipt is not drawn under it as a line saying the same once more. A receipt
   * whose card is on another page, or sits inside a folded execution record, keeps its line: there it is the only word
   * of the outcome. Display only: the native record of the receipt is untouched.
   */
  receiptsOnCards(messages: NativeMessage[]): Set<string> {
    const receipts = new Map<ApprovalDecision, string>(), said = new Set<string>();
    for (const message of messages) { const receipt = approvalReceipt(message); if (receipt) receipts.set(receipt, message.id); }
    if (!receipts.size) return said;
    // In page order, as decisions() gives them: a card takes the first receipt that answers it.
    const decided = [...receipts.keys()], kinds = messagePresentation(messages);
    for (const message of messages) {
      if (message.type === 'user' || kinds.get(message.id) !== 'message') continue;
      for (const receipt of cardReceipts(message, decided)) said.add(receipts.get(receipt)!);
    }
    return said;
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
  /**
   * A new cat, by whichever way it is made. Every new cat starts without this
   * computer (Computer.keepOff): a second native step after the cat exists,
   * like its starting arguments. When that step could not be done or
   * confirmed the cat is still returned, and creationNotice has the words.
   */
  async createBot(input: CreateBot, source?: NativeCat): Promise<NativeCat> {
    const cat = await this.makeBot(input, source);
    const notice = await this.computer.keepOff(cat);
    if (notice) {
      this.creationNotices.set(cat.id, notice);
      for (const old of this.creationNotices.keys()) { if (this.creationNotices.size <= 50) break; this.creationNotices.delete(old); }
    }
    return cat;
  }
  /** Said once, with the creation's answer. */
  creationNotice(cat: NativeCat): string | undefined {
    const notice = this.creationNotices.get(cat.id);
    this.creationNotices.delete(cat.id);
    return notice;
  }
  private async makeBot(input: CreateBot, source?: NativeCat): Promise<NativeCat> {
    if (input.simple) {
      if (source || input.catConfig || input.sourceTemplate || input.runtimeId || input.templateId || input.persona !== undefined || input.description !== undefined)
        throw new ApiError(400, '快速创建只需要名字，不能与其他配置混用');
      if (!input.idempotencyKey) throw new ApiError(400, '创建猫猫需要请求标识');
      return this.createSimple(input.name, input.simple, input.idempotencyKey, input.timezone);
    }
    if (input.catConfig) {
      if (source || input.runtimeId || input.templateId || input.persona !== undefined || input.description !== undefined)
        throw new ApiError(400, '创建配置不能与旧版字段混用');
      const result = await this.native.request<{ cat: NativeCat; sourceTemplate: SourceTemplate | null }>('/api/bot-cat-templates/instantiate', {
        method: 'POST', body: { name: input.name, catConfig: input.catConfig,
          ...(input.sourceTemplate ? { sourceTemplate: input.sourceTemplate } : {}), idempotencyKey: input.idempotencyKey ?? randomUUID() },
      });
      const cat = result.cat;
      if (!cat?.id || !cat.breedId) throw new ApiError(502, '引擎的创建结果缺少猫猫身份');
      const identity = avatarBreed(cat.breedId);
      Object.assign(this.store.bot(cat.id), { templateId: identity, avatarSeed: input.avatar_seed || `cat:${identity}`,
        timezone: input.timezone, ...(result.sourceTemplate ? { sourceTemplate: result.sourceTemplate } : {}) });
      this.store.save();
      return this.withStartingArguments(cat);
    }
    if (input.sourceTemplate) throw new ApiError(400, '缺少创建配置');
    if ((await this.cats()).some(c => c.name.toLowerCase() === input.name.toLowerCase())) throw new ApiError(409, '已经有一只叫这个名字的猫猫了', undefined, 'name_taken');
    const templates = await this.templates();
    const requestedTemplate = input.templateId ?? (source ? this.store.bot(source.id).templateId : undefined) ?? 'ragdoll';
    const template = templates.templates.find(t => t.id === requestedTemplate);
    if (!template) throw new ApiError(503, '上游角色模板不可用');
    const runtimes = await this.runtimes();
    const installed = runtimes.filter(r => r.installed && supportsRuntime(r) && !runtimeUnavailable(r));
    const runtime = input.runtimeId ? runtimes.find(r => r.id === input.runtimeId) : source ? installed.find(r => r.clientId === source.clientId) : defaultRuntime(runtimes);
    if (!runtime) throw new ApiError(422, '请先装好并登录一个本机 Agent（Claude Code 或 Codex），再来选择。');
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
    return this.withStartingArguments(cat);
  }
  /**
   * The CLI arguments a new cat starts with (memberCliArgs), written as their
   * own native step after the member exists. The creation request itself never
   * carries them: its shape stays what native recorded for its key, so a repeat
   * of an older request still matches, whatever the defaults are by then. A
   * member that already has arguments is left alone. A refused write is tried
   * once more against the member's current revision; if it still fails the
   * cat exists and works, and is returned without the arguments — the caller
   * can tell from the record (startingArgumentsMissing) and says so.
   */
  private async withStartingArguments(created: NativeCat): Promise<NativeCat> {
    const args = memberCliArgs(created.clientId), has = (cat: NativeCat) => Array.isArray(cat.cliConfigArgs) && cat.cliConfigArgs.length > 0;
    let cat = created;
    for (let attempt = 0; args.length && !has(cat) && attempt < 2; attempt++) {
      try {
        const updated = await this.native.request<{ cat: NativeCat }>(`/api/cats/${encode(cat.id)}`, { method: 'PATCH',
          body: { expectedRevision: cat.configurationRevision, cliConfigArgs: args } });
        if (updated.cat?.id) cat = updated.cat;
      } catch {
        // Someone edited the member in between, or the write did not go through: look at it as it is now.
        const current = await this.cats().then(cats => cats.find(known => known.id === created.id)).catch(() => undefined);
        if (!current) break;
        cat = current;
      }
    }
    return cat;
  }
  /** True when a cat should have starting arguments (see withStartingArguments) and has none. */
  startingArgumentsMissing(cat: NativeCat): boolean {
    return memberCliArgs(cat.clientId).length > 0 && !(Array.isArray(cat.cliConfigArgs) && cat.cliConfigArgs.length > 0);
  }
  /**
   * A cat from a name alone, on the unpatched native member creation
   * (POST /api/cats): the colour of the chosen face and, unless the owner
   * asked for a custom cat, the portrait and the tool of the engine's cat for
   * that face; the tool's own model and effort. The request carries native's
   * own creation identity (journey + key), so sending it again returns the
   * same cat and a different request under the same key is refused.
   *
   * A repeat of a request (its answer got lost) is handled by what is known:
   * - the same request again in this process is replayed to native exactly as
   *   it was first resolved (the tool and the template's words of that moment);
   * - if no cat was made and the tool it was resolved to is no longer usable,
   *   it is resolved afresh, so nothing is made on a tool that is not here;
   * - when this process has no record of the request but the cat its key made
   *   is there, the answer is that cat — never "nothing was created" — as long
   *   as the request still describes it; otherwise it is a different request.
   * Identical requests arriving together share one resolution.
   */
  private async createSimple(name: string, simple: NonNullable<CreateBot['simple']>, key: string, timezone?: string): Promise<NativeCat> {
    const catId = `bot-${createHash('sha256').update(`bot-simple-cat:${key}`).digest('hex').slice(0, 24)}`;
    const cats = await this.cats(), existing = cats.find(cat => cat.id === catId);
    if (cats.some(cat => cat.id !== catId && cat.name.toLowerCase() === name.toLowerCase())) throw new ApiError(409, '已经有一只叫这个名字的猫猫了', undefined, 'name_taken');
    const about = simple.about?.trim(), temper = simple.personality?.trim();
    // Custom keeps only the face's looks; otherwise picking a face picks that cat.
    const custom = simple.custom === true || !!about || !!temper;
    const input = createHash('sha256').update(JSON.stringify([name, simple.face ?? null, simple.rev ?? null, custom, about ?? null, temper ?? null, simple.agent ?? null])).digest('hex');
    // Said by code as well, so a page can tell it from a name that is taken.
    const different = (details?: unknown) => new ApiError(409, '这次创建和上一次的内容不一样，或者名字已被占用，请重新创建', details, 'request_changed');
    const keep = (cat: NativeCat, face: string) => {
      const meta = this.store.bot(cat.id);
      if (meta.templateId !== face || !meta.avatarSeed) { Object.assign(meta, { templateId: face, avatarSeed: `cat:${face}`, ...(timezone ? { timezone } : {}) }); this.store.save(); }
      return this.withStartingArguments(cat);
    };
    let sent = this.simpleRequests.get(key);
    if (sent && sent.input !== input) {
      // This key already stands for another request. If that one made its cat, this is not a repeat of it.
      if (existing) throw different();
      sent = undefined;
    }
    if (!sent && existing) {
      // No record of the request here (the process restarted since), but the cat its key made exists: creation is not asked
      // again, and it is not re-resolved against templates and tools that may have changed. What can be told from the cat
      // itself is compared with the request; a request that asks for something else is a different one.
      const meta = this.store.bot(existing.id), face = simple.face ?? meta.templateId ?? 'ragdoll';
      const tool = simple.agent ? (await this.runtimes()).find(r => r.id === simple.agent)?.clientId ?? '' : !custom && simple.face ? faceTools[simple.face as Face].client : undefined;
      if (existing.name !== name || (simple.face && meta.templateId && meta.templateId !== simple.face) || (tool !== undefined && tool !== existing.clientId)
        || (about !== undefined && existing.roleDescription !== about) || (temper !== undefined && existing.personality !== temper)
        || (custom && !about && existing.roleDescription !== defaultRole)) throw different();
      return keep(existing, face);
    }
    if (sent && !existing) {
      // Nothing was made by the earlier attempt. The tool it was resolved to has to be usable still, or the request is resolved afresh.
      const tool = (await this.runtimes(true)).find(r => r.id === sent!.tool);
      if (!tool || runtimeUnavailable(tool)) { this.simpleRequests.delete(key); sent = undefined; }
    }
    if (!sent) {
      // Identical requests that arrive together are resolved once: whichever tool and words that reading found are the request's.
      const flight = `${key}:${input}`;
      let resolving = this.simpleResolving.get(flight);
      if (!resolving) {
        resolving = this.resolveSimple(name, simple, catId, custom, about, temper, input).finally(() => this.simpleResolving.delete(flight));
        this.simpleResolving.set(flight, resolving);
      }
      const resolved = await resolving, kept = this.simpleRequests.get(key);
      sent = kept?.input === input ? kept : resolved;
      this.simpleRequests.set(key, sent);
      // Only recent requests can still be retried; the oldest go first.
      for (const old of this.simpleRequests.keys()) { if (this.simpleRequests.size <= 50) break; this.simpleRequests.delete(old); }
    }
    const journey = 'clowder-bot-simple';
    const { cat } = await this.native.request<{ cat: NativeCat }>('/api/cats', { method: 'POST',
      headers: { 'x-cat-cafe-onboarding-journey': journey, 'idempotency-key': `onboarding:${journey}:cat:${key}` },
      body: sent.body }).catch(error => {
      if (error instanceof ApiError && error.status === 409) throw different(error.details);
      throw error;
    });
    if (!cat?.id) throw new ApiError(502, '没能确认猫猫是否建好，请刷新后查看');
    return keep(cat, sent.face);
  }
  /** What a creation request comes to right now: which cat, which tool, which words. Refuses, before native is asked, what cannot be made. */
  private async resolveSimple(name: string, simple: NonNullable<CreateBot['simple']>, catId: string, custom: boolean, about: string | undefined, temper: string | undefined, input: string) {
    const runtimes = await this.runtimes(true);
    const usual = defaultRuntime(runtimes), none = '这台电脑上还没有可以用的 Agent，装好并登录 Claude Code 或 Codex 后再试。';
    let runtime: NativeRuntime | undefined;
    if (custom) {
      // A custom cat only borrows the looks: it thinks with the tool the owner picked, or the usual one.
      runtime = simple.agent ? runtimes.find(r => r.id === simple.agent) : usual;
      if (!runtime) throw new ApiError(422, simple.agent ? '找不到选的这个 Agent，请重新选择。' : none);
      // Said with the Agent's own name.
      if (runtimeUnavailable(runtime)) throw new ApiError(422, runtime.readiness?.status === 'login_required'
        ? `${runtime.label} 还没有登录，登录后再试。` : `这台电脑上的 ${runtime.label} 现在用不了，换一个或稍后再试。`);
    } else {
      // Picking a face picks that cat, and which tool it thinks with is part of the cat: it is not chosen separately,
      // and without that tool on this computer the cat cannot be made as it is. No face picked: the cat of the tool
      // that was asked for, or of the one this computer would use anyway.
      const asked = simple.agent ? runtimes.find(r => r.id === simple.agent) : usual;
      const picked: Face | undefined = simple.face as Face | undefined ?? (asked && faceOfTool(asked));
      if (!picked) throw new ApiError(422, simple.agent ? '找不到选的这个 Agent，请重新选择。' : none);
      const tool = faceTool(picked, runtimes);
      // 自定义 is only a way forward when some tool here can be used.
      if (!tool.runtime) throw new ApiError(422, tool.state === 'login' ? `${tool.reason}，登录后再试。`
        : `${tool.reason}，这只猫猫现在领不了。` + (usual ? `${tool.state === 'missing' ? '装好并登录后再试，或者' : '可以'}改用「自定义」。` : tool.state === 'missing' ? '装好并登录后再试。' : ''),
        undefined, 'face_unavailable');
      if (simple.agent && simple.agent !== tool.runtime.id) throw new ApiError(422, `这只猫猫用 ${tool.label} 来思考，不能另选；想自己选，请用「自定义」。`, undefined, 'face_tool');
      runtime = tool.runtime;
    }
    const face = simple.face ?? faceOfTool(runtime) ?? 'ragdoll';
    // Nothing has been asked of native yet: this is a refusal, not an unsure creation, and says so by code.
    const template = (await this.faceTemplates().catch(() => [])).find(known => known.id === face);
    if (!template?.color) throw new ApiError(503, '暂时读不到猫猫的资料，这次没有创建，请稍后再试', undefined, 'faces_unavailable');
    // The cat that is made is the one that was described: a portrait that changed since the screen read it is shown again first.
    if (!custom && simple.rev && simple.rev !== template.rev) throw new ApiError(409, '这只猫猫的介绍刚刚更新了，请再看一眼后重试', undefined, 'face_changed');
    // How a cat talks in a chat is not written here: it is a default of the engine pack this app keeps installed (chat-pack.ts).
    const portrait = custom
      ? { roleDescription: about || defaultRole, personality: temper || defaultPersonality, teamStrengths: about ? clip(about.replace(/\s+/g, ' '), 60) : defaultStrengths }
      // The engine's template of the same id gives the role, the personality and the strengths, as written upstream.
      : { roleDescription: template.roleDescription || defaultRole, personality: template.personality || defaultPersonality, teamStrengths: template.teamStrengths || defaultStrengths };
    return { input, face, tool: runtime.id, body: { catId, name, displayName: name, nickname: name, color: template.color, mentionPatterns: [`@${name}`, `@${catId}`],
      ...portrait, clientId: runtime.clientId, configurationSource: 'native_tool', defaultModel: '' } as Record<string, unknown> };
  }
  async send(thread: NativeThread, body: { text: string; reply_to?: number; idempotencyKey?: string; attachments?: string[]; expectedThreadId?: string }, directCat?: NativeCat) {
    if (body.expectedThreadId && body.expectedThreadId !== thread.id) throw new ApiError(409, '对话已变化，请核对后重试');
    if (body.attachments?.length && !body.expectedThreadId) throw new ApiError(400, '发送附件需要当前对话的标识');
    const attachments = body.attachments?.length ? await this.workspaces.attachments(thread.id, body.attachments) : [];
    const replyTo = body.reply_to ? this.store.messageId(thread.id, body.reply_to) : undefined;
    if (body.reply_to && !replyTo) throw new ApiError(400, '引用的消息不存在，请刷新对话');
    const addressed = directCat?.id ?? (replyTo ? await this.answeredCat(thread, replyTo, body.text, body.idempotencyKey) : undefined);
    await this.manner.ready();
    return this.native.request('/api/messages', { method: 'POST', body: {
      threadId: thread.id, content: body.text, idempotencyKey: body.idempotencyKey ?? randomUUID(),
      // Native admission binds the exact active parent and appends without interrupting.
      // If the carrier cannot append (or is idle), native Queue safely starts the next turn.
      // Do not inspect a stale busy snapshot or issue a second force/steer request here.
      messageDisposition: 'continue_current',
      ...(attachments.length ? { contextAttachments: attachments } : {}),
      ...(addressed ? { mentions: [addressed] } : {}), ...(replyTo ? { replyTo } : {}),
    } });
  }
  /**
   * In a group, an answer to what one cat said goes to that cat, the way a reply does in a chat app. Native routing
   * looks at mentions only, never at replyTo, so the cat is named with the engine's own explicit mention — which
   * replaces what the engine would read from the words. Whether the words name someone is therefore asked of the
   * engine itself (its read-only routing preview, the path admission uses): a cat named in the message, or a line
   * that asks every member (#ideate), keeps the engine's routing, and so does any reason this code does not know.
   * A cat that has left the group cannot be answered: that is said, and nothing is sent. Returns the cat to name.
   */
  private answeredCat(thread: NativeThread, replyTo: string, text: string, key?: string): Promise<string | undefined> {
    if (!key) return this.readAnsweredCat(thread, replyTo, text);
    // The same request sent again (its receipt was lost), or twice at once, names whom it named the first time: native
    // replays an admission only when its recipients are the same, and the group or a cat's readiness may have changed in
    // between. A request is one conversation's (native keys idempotency by conversation too) and is what it said and
    // answered: a key reused for other words or another message is not that request. The answer is shared from before
    // the first read, so two sends of it cannot each work out their own.
    const slot = JSON.stringify([thread.id, key, replyTo, text]), known = this.addressedReplies.get(slot);
    if (known) return known;
    const asked = this.readAnsweredCat(thread, replyTo, text);
    this.addressedReplies.set(slot, asked);
    // A request that was refused or could not be read named no one; the next attempt asks again.
    asked.catch(() => { if (this.addressedReplies.get(slot) === asked) this.addressedReplies.delete(slot); });
    // Bookkeeping of recent requests only; the oldest go first.
    if (this.addressedReplies.size > 500) this.addressedReplies.delete(this.addressedReplies.keys().next().value!);
    return asked;
  }
  private async readAnsweredCat(thread: NativeThread, replyTo: string, text: string): Promise<string | undefined> {
    const answered = await this.findMessage(thread.id, replyTo);
    // Native would drop a quote of a message that is not in the conversation, silently; say it instead.
    if (!answered) throw new ApiError(400, '引用的消息不存在，请刷新对话');
    if (answered.type !== 'assistant' || !answered.catId) return undefined;
    const preview = await this.native.request<{ reason?: { kind?: string; baseKind?: string }; unavailableTargets?: unknown[] }>('/api/routing/preview', { method: 'POST', body: { scope: 'thread', threadId: thread.id, content: text } });
    const reason = preview.reason?.kind === 'thread_policy' ? preview.reason.baseKind : preview.reason?.kind;
    // The engine found no one named in the words and would fall back on the conversation's history or its members. A cat
    // it met in the words and passed over because that cat cannot run (unavailableTargets) was named all the same: what
    // happens then is the engine's to decide and to say.
    if (!reason || !['previous_user_mentions', 'recent_replier', 'preferred_cat', 'default_cat', 'available_participant'].includes(reason)) return undefined;
    if (Array.isArray(preview.unavailableTargets) && preview.unavailableTargets.length) return undefined;
    if (!thread.preferredCats?.includes(answered.catId)) {
      const name = (await this.cats()).find(known => known.id === answered.catId)?.name;
      throw new ApiError(409, `${name ? `「${name}」` : '这只猫猫'}已经不在这个群里，这句话没有发出去。想问群里的猫猫，可以 @ 它再发。`, undefined, 'reply_cat_left');
    }
    return answered.catId;
  }
  /** One message of a conversation by its native id: the newest page first, then further back until it is met. */
  async findMessage(threadId: string, id: string): Promise<NativeMessage | undefined> {
    const seen = new Set<string>();
    for (let before: string | undefined;;) {
      const page = await this.messages(threadId, before), found = page.messages.find(message => message.id === id);
      if (found || !page.hasMore) return found;
      const first = page.messages[0];
      if (!first) throw new ApiError(502, '引擎的消息分页返回了空游标');
      before = `${first.timelineOrderAt ?? first.timestamp}:${first.id}`;
      if (seen.has(before)) throw new ApiError(502, '引擎的消息分页没有前进');
      seen.add(before);
    }
  }
  async stop(threadId: string, catId?: string) {
    const queue = await this.queue(threadId);
    // Withdrawal and active cancellation use native APIs and remain separately observable.
    if (!catId) await this.native.request(`/api/threads/${encode(threadId)}/queue`, { method: 'DELETE' });
    else for (const entry of queue.queue) {
      if (entry.status !== 'processing' && (entry.targetCatId === catId || entry.targetCats?.includes(catId))) {
        if (entry.targetCats && (entry.targetCats.length !== 1 || entry.targetCats[0] !== catId)) throw new ApiError(409, '这条排队的消息还发给了别的猫猫，暂时不能只撤回这一只的');
        if (typeof entry.messageId !== 'string') throw new ApiError(409, '这条排队的消息暂时无法撤回');
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
