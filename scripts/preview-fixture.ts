// A stand-in for the native runtime, for looking at the interface without an
// engine, a model or the owner's data: the real Bot adapter over a scripted
// protocol fixture. It replays the event shapes the pinned engine sends for a
// turn (see docs/chat-live-api.md) so a reply can be watched being written,
// stopped or failing, and it can put the first screen into states a machine
// with working tools cannot show (nothing installed, login needed).
//
//   npm run preview:fixture            → http://127.0.0.1:3230
//   PREVIEW_PORT=3231 PREVIEW_CATS=0 npm run preview:fixture
//   curl -X POST :3230/__preview -H 'Content-Type: application/json' -d '{"agents":"login"}'
//   …  -d '{"speed":3}'  (slower playback)   -d '{"approvals":"failing"}'  (agreeing fails like a broken store)
//   …  -d '{"page":12}'  (read conversations 12 messages at a time, to see earlier pages load)
//   …  -d '{"wechat":"slow"}'  (应用: ok | slow | fail | timeout | absent | present | crashed)   -d '{"probe":"fail"}'  (no custom app answers; "ok" restores)
//   …  -d '{"append":"off"}'  (a cat that is writing does not take in what is said meanwhile; it answers that afterwards)
//   curl :3230/__preview   → {preview, scene: "plain" | "showcase", staged, zone, plays[], cats[]} (what this is; changes nothing)
// Typed words steer the canned reply: 长, 文件/查/资料, 慢, 失败, 清单, 选一个, 确认一下, 记住, 提醒/定时; 谢谢/晚安/再见 gets one
// emoji and nothing else (a reaction); a message that is itself one emoji gets the cat going on when it answers a question
// of the cat's (确认一下 → 👍), and one emoji back otherwise;
// in a group @名字 picks the cat and 大家/@all asks all of them; a message that names no cat is taken, as in the engine,
// by the cat last addressed by name, else the one that spoke last, else the first member.
//
//   npm run showcase                   → the same preview with a staged contact list: one cat per engine
//   template and two groups, each chat showing one thing the app can do (scripts/showcase-scene.ts), and
//   the illustrated guide to those abilities at /tour/. `{"play":"布偶猫"}` sends that chat's demo line.
//
// Never linked from production and never a fallback: the replies are canned
// and say so. State lives in a temporary directory that is removed on exit.
import express from 'express';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { ApiError } from '../server/errors.js';
import type { NativeRuntime } from '../server/native/bridge.js';
import type { NativeCat, NativeEvent, NativeMessage } from '../server/native/types.js';
import { NativeFixture, catTemplates } from '../tests/native-fixture.js';
import { soleEmoji } from '../server/native/reactions.js';
import { seedShowcase, type Script, type Proposal } from './showcase-scene.js';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.PREVIEW_PORT || 3230);
if (!Number.isInteger(port) || port === 3210 || port < 1024) throw new Error('The preview needs its own port');
const dir = mkdtempSync(join(tmpdir(), 'clowder-bot-preview-'));
const workspace = join(dir, 'workspace'); mkdirSync(workspace);
const workspaceRoot = realpathSync(workspace);
// The engine's own colour pair for each template (GET /api/cat-templates on the pinned runtime, read 2026-11-12).
const templateColours: Record<string, [string, string]> = { ragdoll: ['#9B7EBD', '#E8DFF5'], 'maine-coon': ['#5B8C5A', '#D4E6D3'], siamese: ['#5B9BD5', '#D6E9F8'],
  'turkish-van': ['#6B6F9E', '#E2E3F0'], dsh: ['#3B7EA1', '#DCEBF2'], 'dragon-li': ['#D4A76A', '#F5EBD7'], bengal: ['#D4853A', '#FAEBDB'], 'golden-chinchilla': ['#C8A951', '#F5EDDA'] };
const wait = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const breeds = ['ragdoll', 'maine-coon', 'siamese', 'turkish-van', 'dsh', 'dragon-li', 'bengal', 'golden-chinchilla'];
const breedNames: Record<string, [string, string, string | null]> = {
  ragdoll: ['布偶猫', '宪宪', 'claude'], 'maine-coon': ['缅因猫', '砚砚', 'codex'], siamese: ['暹罗猫', '烁烁', 'agy-native'],
  'turkish-van': ['梵花猫', '墨墨', 'kimi'], dsh: ['小鲸鱼', '鲸鲸', null], 'dragon-li': ['狸花猫', '小狸花', 'opencode'],
  bengal: ['孟加拉猫', '斑斑', 'antigravity'], 'golden-chinchilla': ['金渐层', '金哥', 'opencode'],
};
const agentSets: Record<string, NativeRuntime[]> = (() => {
  const make = (id: string, label: string, clientId: string, status: 'configured' | 'login_required' | 'unknown' | 'not_installed', loginCommand: string): NativeRuntime =>
    ({ id, label, clientId, installed: status !== 'not_installed', configuredModel: status === 'not_installed' ? undefined : 'preview-model', configuredEffort: 'medium',
      models: [], command: id, readiness: { status, checkedAt: Date.now(), loginCommand } });
  const set = (codex: any, claude: any, kimi: any = 'not_installed') => [make('codex', 'Codex', 'openai', codex, 'codex login'), make('claude', 'Claude Code', 'anthropic', claude, 'claude auth login'),
    make('kimi', 'Kimi', 'kimi', kimi, 'kimi login')];
  // The other tools the pinned engine's detection lists (ids, labels and clients read from the isolated runtime, 2026-11-12); the app
  // cannot connect cats to them yet. On the showcase's computer the two whose cats are staged as answering (DSH, AGY) are installed.
  const others = (here: string[]): NativeRuntime[] => [['dsh', 'DSH', 'acp', 'acp'], ['agy-native', 'AGY Native', 'google', undefined], ['agy-acp', 'AGY 官方 ACP', 'google', undefined], ['pi', 'Pi', 'acp', 'acp']]
    .map(([id, label, clientId, transport]) => ({ id: id!, label: label!, clientId: clientId!, installed: here.includes(id!), models: [], ...(transport ? { transport } : {}),
      readiness: { status: here.includes(id!) ? 'configured' as const : 'not_installed' as const, checkedAt: Date.now() } }));
  return { ready: set('configured', 'configured'), unknown: set('unknown', 'not_installed'), login: set('login_required', 'not_installed'), none: set('not_installed', 'not_installed'),
    // The showcase's computer: the three tools the app can connect, all logged in, and the engine's list of the rest.
    showcase: [...set('configured', 'configured', 'configured'), ...others(['dsh', 'agy-native'])] };
})();

export class PreviewNative extends NativeFixture {
  listeners = new Map<string, Set<(event: NativeEvent) => void>>();
  /** Replies being written. `more` holds what the owner said to that cat meanwhile: the engine lets the same reply take it in. */
  turns = new Map<string, { threadId: string; catId: string; invocationId: string; stop: boolean; reply?: NativeMessage; more: NativeMessage[] }>();
  speed = 1; counter = 0; epoch = randomUUID(); seq = new Map<string, number>();
  /** What cats asked the owner to confirm (the native Approval Hub), and whether deciding should fail like a broken store. */
  hub: Array<Record<string, any>> = []; hubFails = false;
  /** The engine's reminders (GET /api/schedule/tasks); agreeing to a proposed one adds it here, as native does. */
  schedules: Array<Record<string, any>> = [];
  /** Conversation notes by thread (GET /api/memory?threadId=). */
  notes = new Map<string, Array<{ key: string; value: string; updatedAt: number }>>();
  /** Whether a cat that is writing can take in what is said meanwhile (the engine's append); off, such a message gets a reply of its own afterwards. */
  appendable = true;
  /** A staged scene's own reply for a chat (scripts/showcase-scene.ts); undefined keeps the typed-word replies below. */
  scene?: (threadId: string, cat: NativeCat, text: string) => Script | undefined;
  constructor() { super(); this.runtimes = agentSets.ready!; }
  /** The engine's colour pair for a template. */
  colour(id: string) { return { primary: templateColours[id]?.[0] ?? '#888888', secondary: templateColours[id]?.[1] ?? '#eeeeee' }; }
  override async subscribe(id: string, listener: (event: NativeEvent) => void) {
    const set = this.listeners.get(id) ?? new Set(); set.add(listener); this.listeners.set(id, set);
    listener({ type: 'resync', threadId: id });
    return () => { set.delete(listener); };
  }
  emit(threadId: string, event: NativeEvent, sequenced = false) {
    const next = sequenced ? (this.seq.get(threadId) ?? 0) + 1 : undefined;
    if (next) this.seq.set(threadId, next);
    for (const listener of this.listeners.get(threadId) ?? []) listener({ ...event, threadId, ...(next ? { seq: next, seqEpoch: this.epoch } : {}) });
  }
  id(at = Date.now()) { return `${String(at).padStart(16, '0')}-${String(++this.counter).padStart(6, '0')}-${randomBytes(4).toString('hex')}`; }
  override async request<T>(path: string, options: { method?: string; body?: any } = {}): Promise<T> {
    const method = options.method ?? 'GET', body = options.body, url = new URL(path, 'http://fixture');
    const parts = url.pathname.split('/').map(decodeURIComponent);
    const done = (result: unknown) => { this.calls.push({ path, method, body }); if (this.calls.length > 500) this.calls.splice(0, 250); return structuredClone(result) as T; };
    // The eight templates with the colours the engine gives them, so each cat has its own.
    if (url.pathname === '/api/cat-templates' && method === 'GET') return done({ clientDefaults: {}, templates: catTemplates.map(([id, name, roleDescription, personality, teamStrengths, nickname]) =>
      ({ id, name, nickname, roleDescription, personality, teamStrengths, color: this.colour(id) })) });
    // A conversation's folder really exists here (inside the preview's temporary directory), so files can be sent and kept.
    if (url.pathname === '/api/projects/mkdir' && method === 'POST') {
      const target = resolve(String(body.parentPath), String(body.name));
      if (target.startsWith(workspaceRoot + sep)) mkdirSync(target, { recursive: true });
    }
    if (url.pathname === '/api/memory' && ['GET', 'POST', 'DELETE'].includes(method)) {
      const write = method === 'POST';
      if (write && (typeof body?.threadId !== 'string' || typeof body.key !== 'string' || typeof body.value !== 'string')) throw new ApiError(400, 'Invalid request');
      const id = write ? body.threadId as string : url.searchParams.get('threadId') ?? '', list = this.notes.get(id) ?? [];
      if (method === 'GET') return done({ entries: list });
      if (write) { this.notes.set(id, [...list.filter(note => note.key !== body.key), { key: body.key, value: body.value, updatedAt: Date.now() }]); return done({ key: body.key }); }
      this.notes.set(id, list.filter(note => note.key !== url.searchParams.get('key'))); return done({ status: 'ok' });
    }
    // Where a remembered preference came from, as native answers it (routes/taste-browse-source.ts): the owner's
    // own message that the request was about, under the conversation's title — not the cat's request card.
    if (parts[2] === 'memory' && parts[3] === 'taste' && parts[5] === 'source' && method === 'GET') {
      const from = this.memoryViews.taste.entries.find((entry: any) => entry.id === parts[4])?.from;
      const thread = from && this.threads.get(from.threadId);
      return done(thread && from.messageId ? { status: 'ready', title: thread.title?.trim() || null, canOpen: true, threadId: thread.id, messageId: from.messageId }
        : { status: 'not_recorded', title: null, canOpen: false });
    }
    if (url.pathname === '/api/bot-cat-templates' && method === 'GET') return done({ breeds: breeds.map(id => ({ id, name: breedNames[id]![0] })),
      templates: breeds.map((id, index) => ({ id: 'seed:' + id, revision: index + 1, name: breedNames[id]![0], nameHint: breedNames[id]![1], source: { kind: 'user' },
        runtimeId: breedNames[id]![2], breed: { mode: 'explicit', breedId: id }, model: { mode: 'inherit' }, effort: { mode: 'inherit' },
        portrait: { roleDescription: '预览用的角色说明。', personality: '预览', teamStrengths: '预览用的简介' } })) });
    if (url.pathname === '/api/bot-cat-templates/instantiate' && method === 'POST') {
      const config = body.catConfig, runtime = this.runtimes.find(r => r.id === config.runtimeId);
      if (!runtime || !runtime.installed || runtime.readiness?.status === 'login_required') throw new ApiError(422, '这个 Agent 现在不可用');
      if (this.cats.some(cat => cat.name === body.name && !cat.id.endsWith(body.idempotencyKey.slice(0, 8)))) throw new ApiError(409, '已有同名猫猫');
      const id = 'bot-preview-' + body.idempotencyKey.slice(0, 8);
      let cat = this.cats.find(known => known.id === id);
      if (!cat) {
        cat = { id, name: body.name, displayName: body.name, nickname: body.name, breedId: config.breed.breedId ?? (runtime.id === 'claude' ? 'ragdoll' : 'maine-coon'),
          roleDescription: config.portrait.roleDescription, personality: config.portrait.personality, teamStrengths: config.portrait.teamStrengths,
          clientId: runtime.clientId, configurationSource: 'native_tool', defaultModel: config.model.value ?? '', mentionPatterns: ['@' + body.name],
          color: { primary: '#888', secondary: '#eee' }, configurationRevision: 'r1', isDefaultResponder: this.cats.length === 0 } as NativeCat;
        this.cats.push(cat);
      }
      return done({ cat, sourceTemplate: null });
    }
    // Native replays a member creation that carries the same identity; here the same ID is enough.
    if (url.pathname === '/api/cats' && method === 'POST') {
      const existing = this.cats.find(cat => cat.id === body.catId);
      if (existing) return done({ cat: existing });
      const cat = { ...body, id: body.catId, breedId: body.catId, configurationRevision: 'r1', isDefaultResponder: this.cats.length === 0 } as NativeCat;
      this.cats.push(cat); return done({ cat });
    }
    if (url.pathname === '/api/cats/runtime-models') return done({ status: 'live', models: [{ value: 'default', label: '默认', efforts: ['low', 'medium', 'high'].map(value => ({ value, label: value })) }] });
    if (parts[2] === 'cats' && parts[3] && parts.length === 4 && method === 'DELETE') { this.cats = this.cats.filter(cat => cat.id !== parts[3]); return done({ status: 'ok' }); }
    if (parts[2] === 'threads' && parts[3] && parts.length === 4 && method === 'DELETE') { this.threads.delete(parts[3]); return done({ status: 'ok' }); }
    if (url.pathname === '/api/approval-hub/pending') return done({ items: this.hub.filter(item => item.resolution === 'open'),
      manifest: [{ id: 'F221', decisionEndpointBase: '/api/taste-proposals' }, { id: 'F139', decisionEndpointBase: '/api/schedule-proposals' }, { id: 'F231', decisionEndpointBase: '/api/profile-updates' }] });
    const decision = /^\/api\/(?:taste-proposals|schedule-proposals|profile-updates)\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
    if (decision && method === 'POST') {
      const item = this.hub.find(candidate => candidate.proposalId === decodeURIComponent(decision[1]!) && candidate.resolution === 'open');
      if (!item) throw new ApiError(404, 'Proposal not found');
      // The real engine fails this way when its taste store cannot be written (see docs/chat-app-roadmap.md).
      if (this.hubFails && decision[2] === 'approve') throw new ApiError(500, 'Vignette write failed', { error: 'Vignette write failed', detail: 'preview: the store is switched to failing' });
      this.decide(item, decision[2] === 'approve');
      this.emit(item.navigation.approvalCardRef.threadId, { type: 'thread_updated' });
      return done({ ok: true });
    }
    if (parts[2] === 'messages' && parts[4] === 'block-state' && method === 'PATCH') {
      for (const list of this.messages.values()) for (const message of list) if (message.id === parts[3]) {
        const block = ((message.extra?.rich as any)?.blocks ?? []).find((candidate: any) => candidate.id === body.blockId);
        if (block) Object.assign(block, { disabled: body.disabled, selectedIds: body.selectedIds });
      }
      return done({ status: 'ok' });
    }
    if (url.pathname === '/api/schedule/tasks' && method === 'GET') return done({ tasks: this.schedules, botScheduleVersion: 1, botSchedulerReady: true });
    if (url.pathname === '/api/schedule/tasks' && method === 'POST') {
      if (typeof body?.params?.targetCatId !== 'string' || typeof body.deliveryThreadId !== 'string' || !body.trigger) throw new ApiError(400, 'Invalid request');
      // A reminder set by hand in a cat's 定时 page; the same request sent again finds the one it made.
      const made = this.schedules.find(task => task.botIdempotencyKey === body.botIdempotencyKey)
        ?? this.remind('dyn-' + Date.now() + '-' + randomBytes(3).toString('hex'), body.params.targetCatId, body.deliveryThreadId, body.display?.label ?? '定时任务', String(body.params.message ?? ''), body.trigger);
      made.botIdempotencyKey = body.botIdempotencyKey;
      return done({ success: true, task: { id: made.id } });
    }
    if (parts[2] === 'schedule' && parts[3] === 'tasks' && parts[4]) {
      const task = this.schedules.find(candidate => candidate.id === parts[4]);
      if (!task) throw new ApiError(404, 'Task not found');
      if (parts[5] === 'runs' && method === 'GET') return done({ runs: task.runs });
      if (method === 'PATCH') { task.enabled = task.effectiveEnabled = body.enabled === true; return done({ success: true }); }
      if (method === 'DELETE') { this.schedules = this.schedules.filter(candidate => candidate !== task); return done({ success: true }); }
    }
    if (parts[2] === 'threads' && parts[4] === 'task-progress') return done({});
    if (parts[2] === 'threads' && parts[4] === 'queue' && method === 'GET') return done({ queue: [], queueRevision: 1,
      activeInvocations: [...this.turns.values()].filter(turn => turn.threadId === parts[3]).map(turn => ({ catId: turn.catId, invocationId: turn.invocationId, startedAt: Date.now(), status: 'running' })) });
    if (parts[2] === 'threads' && parts[4] === 'queue' && method === 'DELETE') return done({ ok: true });
    if (parts[2] === 'threads' && parts[4] === 'cancel' && method === 'POST') {
      for (const turn of this.turns.values()) if (turn.threadId === parts[3] && turn.catId === parts[5]) turn.stop = true;
      return done({ ok: true, cancelled: true });
    }
    // The engine's read-only routing preview, by the same rule this stand-in routes a message with (below).
    if (url.pathname === '/api/routing/preview' && method === 'POST') {
      const thread = this.threads.get(body.threadId); if (!thread) throw new ApiError(404, 'Thread not found');
      const members = (thread.preferredCats ?? []).map(id => this.cats.find(cat => cat.id === id)).filter((cat): cat is NativeCat => !!cat);
      const named = members.filter(cat => String(body.content).includes('@' + cat.name)), all = /大家|@all|@全体/.test(String(body.content));
      return done(all || named.length ? { targetCats: (all ? members : named).map(cat => cat.id), reason: { kind: 'current_message_mentions' } }
        : { targetCats: this.taker(this.messages.get(thread.id) ?? [], members).map(cat => cat.id), reason: { kind: 'recent_replier' } });
    }
    if (url.pathname === '/api/messages' && method === 'POST') {
      const thread = this.threads.get(body.threadId); if (!thread) throw new ApiError(404, 'Missing thread');
      const list = this.messages.get(thread.id) ?? []; this.messages.set(thread.id, list);
      const user: NativeMessage = { id: this.id(), type: 'user', catId: null, timestamp: Date.now(), content: body.content, ...(body.replyTo ? { replyTo: body.replyTo } : {}),
        // What the owner attached travels with the message, as native keeps it.
        ...(Array.isArray(body.contextAttachments) && body.contextAttachments.length ? { contentBlocks: body.contextAttachments.map((attachment: unknown) => ({ type: 'context_attachment', attachment })) } : {}) };
      const members = (thread.preferredCats ?? []).map(id => this.cats.find(cat => cat.id === id)).filter((cat): cat is NativeCat => !!cat);
      const named = members.filter(cat => body.content.includes('@' + cat.name));
      const targets = body.mentions?.length ? members.filter(cat => body.mentions.includes(cat.id)) : /大家|@all|@全体/.test(body.content) ? members : named.length ? named : this.taker(list, members);
      list.push(user);
      const entries = targets.map(cat => ({ entryId: 'queue:' + randomBytes(8).toString('hex'), targetCatId: cat.id }));
      this.emit(thread.id, { type: 'queue_updated', action: 'enqueued' });
      // A cat that is writing a reply here takes the new message into that reply instead of starting another — the engine's
      // continue_current, which is what the app sends; recorded as the engine records it (read off the isolated runtime,
      // 2026-11-12). A message sent as next work, or to a tool that cannot take input while it runs (`appendable` off),
      // waits for the reply to end and gets a reply of its own. Other cats start a turn.
      user.lifecycle = { kind: 'input', dispatchRefs: [] };
      for (const cat of targets) {
        const running = [...this.turns.values()].find(turn => turn.threadId === thread.id && turn.catId === cat.id && !turn.stop);
        if (!running) { void this.turn(thread.id, cat, user).catch(error => console.error('[preview]', error)); continue; }
        if (body.messageDisposition !== 'continue_current' || !this.appendable) {
          void (async () => { while ([...this.turns.values()].includes(running)) await wait(50); await this.turn(thread.id, cat, user); })().catch(error => console.error('[preview]', error));
          continue;
        }
        // Before the reply's record exists the message simply becomes one of its inputs; after, the running reply accepts it.
        if (running.reply) {
          (user.lifecycle.dispatchRefs as unknown[]).push({ targetId: cat.id, phase: 'settled', statusMessageId: running.reply.id, dispatchedAt: Date.now(), inputRead: { status: 'read', at: Date.now() }, appendAcceptance: 'accepted' });
          (running.reply.lifecycle!.inputMessageIds as string[]).push(user.id);
        }
        running.more.push(user);
      }
      return done({ status: 'queued', queuePosition: 1, entryId: entries[0]?.entryId, entries, merged: false, userMessageId: user.id, userMessage: { id: user.id, timestamp: user.timestamp } });
    }
    return super.request(path, options);
  }
  /** A reminder as the engine lists it. */
  remind(id: string, catId: string, threadId: string, label: string, prompt: string, trigger: unknown) {
    const task: Record<string, any> = { id, source: 'dynamic', templateId: 'reminder', targetCatId: catId, prompt, deliveryThreadId: threadId, dynamicTaskId: id, trigger,
      enabled: true, effectiveEnabled: true, registered: true, display: { label }, lastRun: null, runStats: { total: 0, delivered: 0, failed: 0, skipped: 0 }, runs: [] };
    this.schedules.push(task); return task;
  }
  /**
   * A cat asks the owner to confirm something, as native does: the request is its own card message,
   * registered in the hub and anchored to that message. The cards are in the shapes the real engine
   * writes them (copied from the isolated runtime, 2026-11-11).
   */
  propose(threadId: string, cat: NativeCat, proposal: Proposal, at = Date.now(), about?: string) {
    const id = 'proposal_' + randomBytes(8).toString('hex'), detail = proposal.detail as any, name = String(proposal.summary).replace(/^[^:]*:\s*/, '');
    const taskId = 'dyn-' + at + '-' + randomBytes(3).toString('hex');
    const card = proposal.feature === 'F139'
      ? { title: `提议创建定时任务：${name}`, bodyMarkdown: '批准后才会创建并注册该任务；当前尚未产生调度副作用。',
          fields: [{ label: 'Task ID', value: taskId }, { label: 'Template', value: 'reminder' }, { label: 'Trigger', value: JSON.stringify(detail.trigger) }, { label: 'Delivery thread', value: threadId }] }
      : { title: proposal.title, bodyMarkdown: `**猫的判断（假设）：** ${detail.takeaway}\n\n**场景：** 用户明确要求记住的个人偏好\n\n> ${detail.quote}`,
          fields: [{ label: '维度', value: '真实表达' }, { label: '隐私', value: '敏感' }, { label: '捕捉猫', value: cat.id }] };
    const cardMessage: NativeMessage = { id: this.id(at), type: 'assistant', catId: cat.id, timestamp: at,
      content: proposal.feature === 'F139' ? `请求批准创建定时任务「${name}」` : `${proposal.title}：${detail.takeaway}`,
      extra: { rich: { v: 1, blocks: [{ id: 'approval-' + id, kind: 'card', v: 1, ...card, tone: 'info',
        meta: { approval: { producerId: proposal.feature, canonicalProposalId: id } } }] } } };
    const list = this.messages.get(threadId) ?? []; this.messages.set(threadId, list); list.push(cardMessage);
    const item: Record<string, any> = { proposalId: id, sourceFeatureId: proposal.feature, requesterCatId: cat.id, summary: proposal.summary, detail: proposal.detail, resolution: 'open',
      inlineApprovable: true, decisionMode: 'approve-reject', createdAt: at, expiresAt: at + 7 * 86400000,
      navigation: { state: 'anchored', approvalCardRef: { threadId, messageId: cardMessage.id } }, taskId,
      // The owner's message the request is about (native: sourceMessageId / approvalOriginRef).
      ...(about ? { sourceMessageId: about, approvalOriginRef: { kind: 'message', threadId, messageId: about } } : {}) };
    this.hub.push(item); return item;
  }
  /**
   * The owner's answer to a request. The engine then posts its own receipt into the conversation (a
   * connector message from the approval hub) and, on a yes, does what was asked: the reminder is
   * registered, the preference is kept.
   */
  decide(item: Record<string, any>, approve: boolean, at = Date.now()) {
    item.resolution = approve ? 'approved' : 'rejected';
    const ref = item.navigation.approvalCardRef, name = String(item.summary).replace(/^[^:]*:\s*/, '');
    this.messages.get(ref.threadId)?.push({ id: this.id(at), type: 'connector', catId: null, timestamp: at,
      content: `审批结果：提案 ${item.proposalId} ${approve ? '已批准' : '已拒绝'}。`,
      source: { connector: 'approval-hub', label: 'Host 审批结果回执', meta: { presentation: 'system_notice', approvalDecisionReceipt: { v: 1, kind: 'approval_decision_receipt',
        producerId: item.sourceFeatureId, canonicalProposalId: item.proposalId, resolution: approve ? 'accepted' : 'rejected', approvalCardRef: ref, decidedAt: at } } } });
    if (!approve) return;
    if (item.sourceFeatureId === 'F139' && item.detail?.mutationKind === 'create') return this.remind(item.taskId, item.requesterCatId, ref.threadId, name, item.detail.message ?? name, item.detail.trigger);
    // A kept preference as native lists it (routes/taste-browse-model.ts): titled by its takeaway, dated by the day it was proposed.
    if (item.sourceFeatureId === 'F221') this.memoryViews.taste.entries.unshift({ id: 'taste-' + randomBytes(12).toString('hex'), type: 'taste',
      title: String(item.detail.takeaway).slice(0, 160), takeaway: item.detail.takeaway, quotes: item.detail.quote ? [item.detail.quote] : [],
      scene: '用户明确要求记住的个人偏好', status: 'active', when: new Date(item.createdAt).toLocaleDateString('sv'), takeawayCandidate: null, pendingCorrectionCount: 0,
      revision: 'sha256:' + createHash('sha256').update(String(item.detail.takeaway)).digest('hex'), from: { threadId: ref.threadId, messageId: item.sourceMessageId } });
  }
  /** A file a cat hands over with a reply: a native file block on the message, its bytes where native keeps uploads, and a line in the thread's catalogue. */
  publish(threadId: string, message: NativeMessage, file: { name: string; mime: string; bytes: Buffer }) {
    const key = randomBytes(6).toString('hex'), url = `/uploads/preview/${key}${/\.[A-Za-z0-9]{1,8}$/.exec(file.name)?.[0] ?? ''}`;
    const rich = ((message.extra ??= {}).rich ??= { v: 1, blocks: [] }) as { blocks: unknown[] };
    rich.blocks.push({ id: 'file-' + key, kind: 'file', v: 1, fileName: file.name, url, mimeType: file.mime, fileSize: file.bytes.length });
    this.uploads.set(url, file.bytes);
    this.artifactRows.set(threadId, [...(this.artifactRows.get(threadId) ?? []), { type: 'file', sourceMessageId: message.id, name: file.name, createdAt: message.timestamp }]);
  }
  /**
   * Who takes a message that names no cat, as the pinned engine decides it (AgentRouter resolveImplicitTargetPreview):
   * the cat the owner last addressed by name, else the cat that spoke last, else the first member.
   */
  taker(earlier: NativeMessage[], members: NativeCat[]): NativeCat[] {
    const said = [...earlier].reverse();
    for (const message of said) { const named = message.type === 'user' && members.find(cat => message.content.includes('@' + cat.name)); if (named) return [named]; }
    for (const message of said) { const spoke = message.type === 'assistant' && members.find(cat => cat.id === message.catId); if (spoke) return [spoke]; }
    return members.slice(0, 1);
  }
  script(cat: NativeCat, text: string, threadId: string, said?: NativeMessage) {
    const staged = this.scene?.(threadId, cat, text);
    if (staged) return { steps: staged.steps ?? [], reply: staged.reply + `\n\n[${cat.name}/示例🐾]`, fail: staged.fail ?? false, think: staged.think ?? 500,
      blocks: staged.blocks ?? [], proposal: staged.proposal, files: staged.files ?? [] };
    const steps: Array<[string, Record<string, unknown>]> = [];
    let reply: string, fail: boolean | string = false, think = 500;
    if (text.startsWith('聊天页的开场邀请')) reply = `你好呀，我是${cat.name}。今天想聊点什么？`;
    else if (/失败/.test(text)) { reply = '我先看一下…'; fail = true; }
    // One emoji and nothing else, as a reaction is sent: under a question of the cat's own it is the go-ahead and the cat
    // goes on; anywhere else there is nothing to do, and the cat answers with one emoji, as it is told to (chatManner).
    else if (soleEmoji(text)) {
      const about = said?.replyTo ? (this.messages.get(threadId) ?? []).find(message => message.id === said.replyTo) : undefined;
      const asked = about?.type === 'assistant' && /[?？][\s\S]{0,3}$/.test(about.content.replace(/\n\n\[[^\]]*🐾\]\s*$/u, '').trim());
      reply = asked ? '好，那就这么办，我接着做。\n\n这是预览环境里的固定回复，不是真的猫在回答。' : '🐾';
    }
    else if (/^(谢谢|多谢|辛苦了|晚安|再见)/.test(text.trim())) reply = '🐾';
    else if (/长/.test(text)) reply = ['## 先说结论', '这是一段**预览用**的长回复，用来看一条回复被写出来的样子。', '',
      '- 第一点：列表、`行内代码` 和[链接](https://example.com)都会出现。', '- 第二点：下面有一段代码。', '- 第三点：最后是一张表。', '',
      '```js', 'function greet(name) {', '  return `你好，${name}`;', '}', '```', '',
      '| 项目 | 状态 |', '| --- | --- |', '| 流式文字 | 正在写 |', '| 停止 | 随时可以 |', '',
      ...Array.from({ length: 6 }, (_, i) => `第 ${i + 1} 段。猫喜欢纸箱，是因为四面围合的空间让它觉得安全，瓦楞纸又保暖，钻进去像自带一个小暖窝；而且纸箱是家里的新东西，可以啃、可以挠、可以占领。`)].join('\n');
    else if (/文件|查|资料/.test(text)) {
      if (cat.clientId === 'openai') steps.push(['command_execution', { command: "/bin/zsh -lc 'cat 说明.md'" }], ['file_change', { status: 'completed', changes: [{ path: '/preview/workspace/结果.md', kind: { type: 'add' } }] }]);
      else steps.push(['Read', { file_path: '/preview/workspace/说明.md' }], ['WebSearch', { query: '猫 为什么 喜欢 纸箱' }], ['Write', { file_path: '/preview/workspace/结果.md', content: '…' }]);
      reply = '看过说明、查了资料，也把要点写进了 `结果.md`。\n\n简单说：纸箱让猫觉得**安全又暖和**。';
    } else { if (/慢/.test(text)) think = 6000; reply = `收到：「${text.slice(0, 40)}」。\n\n这是预览环境里的固定回复，不是真的猫在回答。`; }
    // What a cat can attach besides words (docs/chat-experience-api.md「卡片、清单与选项」).
    const blocks: Array<Record<string, unknown>> = [];
    let proposal: Proposal | undefined;
    if (/清单/.test(text)) { reply = '列好了：'; blocks.push({ id: 'list-' + randomBytes(3).toString('hex'), kind: 'checklist', v: 1, title: '今天要做的事',
      items: [{ id: 'a', text: '给猫添水', checked: true }, { id: 'b', text: '回两封邮件' }, { id: 'c', text: '下午三点的会' }] }); }
    else if (/选一个|选项/.test(text)) { reply = '你想要哪一种？'; blocks.push({ id: 'pick-' + randomBytes(3).toString('hex'), kind: 'interactive', v: 1, interactiveType: 'select', title: '周末安排',
      options: [{ id: 'home', label: '在家看书', emoji: '📚' }, { id: 'park', label: '去公园', emoji: '🌳' }, { id: 'other', label: '别的', customInput: true }], messageTemplate: '我选 {selection}' }); }
    else if (/确认一下/.test(text)) { reply = '要我现在开始吗？'; blocks.push({ id: 'ok-' + randomBytes(3).toString('hex'), kind: 'interactive', v: 1, interactiveType: 'confirm', title: '开始整理资料',
      options: [{ id: '__confirm__', label: '开始' }, { id: '__cancel__', label: '先不用' }] }); }
    else if (/记住/.test(text)) { reply = '好，这个我想记下来，等你点头。'; proposal = { feature: 'F221', title: '提议捕捉品味信号', summary: 'Taste [authentic-expression]: 回答简短、先说结论',
      detail: { takeaway: '回答简短一点，先说结论', quote: text.slice(0, 60), privacy: 'sensitive' } }; }
    else if (/提醒|定时/.test(text)) { reply = '可以，我来设一个定时，等你确认。'; proposal = { feature: 'F139', title: '提议新建定时任务', summary: 'Create schedule: 喝水提醒',
      detail: { mutationKind: 'create', trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' } } }; }
    return { steps, reply: reply + `\n\n[${cat.name}/preview🐾]`, fail, think, blocks, proposal, files: [] as NonNullable<Script['files']> };
  }
  async turn(threadId: string, cat: NativeCat, user: NativeMessage) {
    const list = this.messages.get(threadId)!, invocationId = randomUUID(), key = `${threadId}:${cat.id}:${invocationId}`;
    const state: { threadId: string; catId: string; invocationId: string; stop: boolean; reply?: NativeMessage; more: NativeMessage[] } = { threadId, catId: cat.id, invocationId, stop: false, more: [] };
    this.turns.set(key, state);
    const first = this.script(cat, user.content, threadId, user);
    const message: NativeMessage = { id: this.id(), type: 'assistant', catId: cat.id, timestamp: Date.now(), content: '', origin: 'stream', replyTo: user.id,
      lifecycle: { kind: 'response', status: 'processing', invocationId, inputMessageIds: [user.id], startedAt: Date.now() }, toolEvents: [] };
    (user.lifecycle?.dispatchRefs as unknown[] | undefined)?.push({ targetId: cat.id, phase: 'settled', statusMessageId: message.id, dispatchedAt: Date.now() });
    const stamp = { catId: cat.id, messageId: message.id, invocationId: 'outer-' + invocationId, turnInvocationId: invocationId };
    const info = (content: Record<string, unknown>, more: Record<string, unknown> = {}) =>
      this.emit(threadId, { type: 'system_info', ...stamp, content: JSON.stringify(content), timestamp: Date.now(), ...more }, true);
    const settle = (status: string, reason?: string) => {
      message.lifecycle = { ...message.lifecycle, kind: 'response', status, invocationId, completedAt: Date.now(), ...(reason ? { reason } : {}) }; delete message.isDraft;
      this.turns.delete(key); this.emit(threadId, { type: 'queue_updated', action: 'completed' });
    };
    await wait(120 * this.speed);
    list.push(message);
    // What was said to this cat before its reply's record existed is simply among the reply's inputs; from here on a message is appended to it.
    for (const early of state.more) {
      (message.lifecycle!.inputMessageIds as string[]).push(early.id);
      (early.lifecycle?.dispatchRefs as unknown[] | undefined)?.push({ targetId: cat.id, phase: 'settled', statusMessageId: message.id, dispatchedAt: Date.now() });
    }
    state.reply = message;
    this.emit(threadId, { type: 'queue_updated', action: 'processing' });
    info({ type: 'invocation_created', invocationId }, { messageId: undefined, lifecycleResponseMessageId: message.id });
    await wait(300 * this.speed);
    // The two carriers mark thinking differently: Claude Code with a system_info, Codex with a transient status.
    const codex = cat.clientId === 'openai';
    const status = (content: string) => this.emit(threadId, { type: 'status', ...stamp, content, timestamp: Date.now() }, true);
    const thinking = () => codex ? status('thinking') : info({ type: 'thinking', catId: cat.id, text: '' });
    const layout = () => ({ outputLayout: { v: 1, owner: { threadId, catId: cat.id, turnInvocationId: invocationId }, contentRevision: { length: written.length, sha256: '' }, status: 'unavailable' } });
    // The stream runs ahead of the persisted draft, as on the real runtime (a draft is flushed about every two seconds).
    let written = '', flushed = Date.now();
    const blocks: Array<Record<string, unknown>> = [], files: NonNullable<Script['files']> = [], proposals: Array<[Proposal, string]> = [];
    /** One answer inside this reply: its thinking, its steps, its words. Returns false when it failed. */
    const answer = async (script: ReturnType<PreviewNative['script']>, to: NativeMessage): Promise<boolean> => {
      thinking();
      for (let waited = 0; waited < script.think && !state.stop; waited += 100) await wait(100 * this.speed);
      for (const [toolName, toolInput] of script.steps) {
        if (state.stop) break;
        this.emit(threadId, { type: 'tool_use', ...stamp, toolName, toolInput, toolUseId: 'toolu_' + randomBytes(6).toString('hex'), timestamp: Date.now() }, true);
        (message.toolEvents as unknown[]).push({ type: 'tool_use', toolName, label: toolName, detail: JSON.stringify(toolInput) });
        await wait(900 * this.speed);
        thinking();
      }
      // An answer to something said meanwhile follows what was written before it, after that part's own signature.
      const text = (written ? '\n\n' : '') + script.reply, end = written.length + text.length;
      for (const piece of text.match(/[\s\S]{1,3}/gu) ?? []) {
        if (state.stop) break;
        written += piece;
        this.emit(threadId, { type: 'text', ...stamp, origin: 'stream', content: piece, textMode: 'append', timestamp: Date.now(), extra: layout() }, true);
        if (codex) {
          status('streaming');
          // Codex also sends the whole reply so far at the end of each paragraph and once more at the end.
          if (piece.includes('\n') || written.length === end) this.emit(threadId, { type: 'text', ...stamp, origin: 'stream', content: written, textMode: 'replace', timestamp: Date.now(), extra: layout() }, true);
        }
        if (Date.now() - flushed > 1800 * this.speed) { message.content = written; message.isDraft = true; flushed = Date.now(); }
        if (script.fail && written.length > 4) break;
        await wait(35 * this.speed);
      }
      if (script.fail) return false;
      blocks.push(...script.blocks); files.push(...script.files);
      if (script.proposal) proposals.push([script.proposal, to.id]);
      return true;
    };
    let failed: boolean | string = false;
    if (!await answer(first, user)) failed = first.fail || true;
    // What the owner said while this was being written is answered in the same reply, in the order it came.
    // If answering one of them fails, the reply fails.
    while (!failed && !state.stop && state.more.length) { const next = state.more.shift()!, script = this.script(cat, next.content, threadId, next); if (!await answer(script, next)) failed = script.fail || true; }
    if (codex) status('done');
    if (state.stop) { message.content = written; settle('canceled'); this.emit(threadId, { type: 'done', ...stamp, isFinal: true, timestamp: Date.now() }, true); return; }
    if (failed) { message.content = ''; settle('failed', typeof failed === 'string' ? failed : undefined); this.emit(threadId, { type: 'error', ...stamp, error: 'preview failure', timestamp: Date.now() }, true); return; }
    message.content = written;
    if (blocks.length) message.extra = { ...message.extra, rich: { v: 1, blocks } };
    for (const file of files) this.publish(threadId, message, file);
    settle('completed');
    this.emit(threadId, { type: 'done', ...stamp, isFinal: true, timestamp: Date.now() }, true);
    for (const [proposal, about] of proposals) this.propose(threadId, cat, proposal, Date.now(), about);
    if (proposals.length) this.emit(threadId, { type: 'thread_updated' });
  }
}

const native = new PreviewNative();
const runtime = createApp({ native, workspace, dataFile: join(dir, 'presentation.json'), staticDir: join(dir, 'no-static'),
  allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`] });
const showcase = process.env.PREVIEW_SCENE === 'showcase';
if (showcase) native.runtimes = agentSets.showcase!;
// The line under 你 names the device; here it says what this is instead of the machine's own name.
runtime.store.state.deviceName = showcase ? '示例环境' : '预览环境';
// Seeded cats come from the same quick creation the first screen uses: 团子 is 布偶猫's cat and answers the way
// Claude Code does, 栗子 is 缅因猫's and answers the way Codex does (see turn()); 年糕 is a custom cat that only borrows a face.
const seeds: Array<[string, Record<string, unknown>]> = [['团子', { face: 'ragdoll' }], ['栗子', { face: 'maine-coon' }], ['年糕', { face: 'siamese', custom: true, agent: 'claude' }]];
if (!showcase) for (const [name, simple] of seeds.slice(0, Math.max(0, Math.min(3, Number(process.env.PREVIEW_CATS ?? 2)))))
  await runtime.bridge.createBot({ name, simple, idempotencyKey: randomUUID() });
/** The staged scene's demo line for each chat and where it goes, by the chat's name (see `{"play": …}` below). */
let plays = new Map<string, { line: string; cat?: string; group?: string }>();
// What this is, readable without changing anything: a tool that clicks through the staged chats (scripts/showcase-shots.mjs)
// asks here first, so it can never be pointed at a real instance; the guide asks whether the staged chats are behind it.
runtime.app.get('/__preview', (_req, res) => res.json({ preview: true, scene: showcase ? 'showcase' : 'plain', staged: plays.size > 0,
  zone: Intl.DateTimeFormat().resolvedOptions().timeZone, plays: [...plays.keys()], cats: native.cats.map(cat => cat.name) }));
runtime.app.post('/__preview', async (req, res) => {
  const input = req.body ?? {};
  if (typeof input.agents === 'string') { if (!agentSets[input.agents]) return res.status(400).json({ error: 'agents: ' + Object.keys(agentSets).join(' | ') }); native.runtimes = agentSets[input.agents]!; }
  if (typeof input.speed === 'number' && input.speed > 0 && input.speed <= 20) native.speed = input.speed;
  if (typeof input.approvals === 'string') native.hubFails = input.approvals === 'failing';
  // {"append": "off"}: a cat that is writing cannot take in what is said meanwhile; that message gets its own reply afterwards. "on" restores it.
  if (typeof input.append === 'string') native.appendable = input.append !== 'off';
  // 应用 (tests/apps-fixture.ts). {"wechat": "ok" | "slow" | "fail" | "timeout"}: what opening 微信 does next time (at once / stays
  // starting for a few reads / fails / the request is cut while the engine goes on); {"wechat": "absent" | "present"}: the engine has
  // no such plugin / has it, off; {"wechat": "crashed"}: enabled but its runtime is not running (the contract's `failed`, item 52's
  // screenshots). {"probe": "ok" | "fail"}: custom apps answer by their script again / none of them answers.
  if (typeof input.wechat === 'string') {
    const apps = native.apps, starts: Record<string, typeof apps.start> = { ok: 'ok', slow: 6, fail: 'fail', timeout: 'timeout' };
    if (input.wechat in starts) apps.start = starts[input.wechat]!;
    else if (input.wechat === 'absent') apps.plugin = null;
    else if (input.wechat === 'present') apps.plugin = { artifact: 'installed', intent: 'disabled', live: 'stopped', lifecycleRevision: 4, diagnostic: null, activationFailed: null, setEnabled: true };
    else if (input.wechat === 'crashed' && apps.plugin) Object.assign(apps.plugin, { intent: 'enabled', live: 'crashed', diagnostic: { code: 'UNEXPECTED_RUNTIME_FAILURE', message: 'Plugin runtime reported UNEXPECTED_RUNTIME_FAILURE.' } });
    else return res.status(400).json({ error: 'wechat: ok | slow | fail | timeout | absent | present | crashed' });
  }
  if (typeof input.probe === 'string') {
    if (!['ok', 'fail'].includes(input.probe)) return res.status(400).json({ error: 'probe: ok | fail' });
    native.apps.probeAll = input.probe === 'fail' ? { connectionStatus: 'disconnected', tools: [], error: 'Probe timeout after 7000ms' } : undefined;
  }
  // {"page": 12}: conversations are read 12 messages at a time, so "earlier messages" can be seen after a few sends; {"page": 0} restores the usual page.
  if (typeof input.page === 'number') native.pageLimit = input.page >= 2 && input.page <= 200 ? Math.floor(input.page) : undefined;
  // {"play": "布偶猫"}: the owner's demo line for that chat is sent through the real adapter, so its staged reply can be watched being written.
  if (typeof input.play === 'string') {
    const target = plays.get(input.play), cat = target?.cat ? native.cats.find(known => known.id === target.cat) : undefined;
    const group = target?.group ? native.threads.get(target.group) : undefined;
    if (!target || (!cat && !group)) return res.status(404).json({ error: 'play: ' + ([...plays.keys()].join(' | ') || '(only in the showcase)') });
    // Answered once the adapter has accepted the line; a line it refused is not reported as played.
    try { await (cat ? runtime.bridge.direct(cat).then(thread => runtime.bridge.send(thread, { text: target.line }, cat)) : runtime.bridge.send(group!, { text: target.line })); }
    catch (error) { return res.status(502).json({ error: 'play: ' + (error instanceof Error ? error.message : 'not sent') }); }
  }
  res.json({ agents: Object.entries(agentSets).find(([, set]) => set === native.runtimes)?.[0], speed: native.speed, approvals: native.hubFails ? 'failing' : 'working', cats: native.cats.map(cat => cat.name) });
});
// The illustrated guide to what the app can do (showcase/), next to the staged chats it points at.
if (existsSync(join(root, 'showcase'))) runtime.app.use('/tour', express.static(join(root, 'showcase'), { etag: false, lastModified: false, setHeaders: res => res.setHeader('Cache-Control', 'no-store') }));
runtime.app.use(express.static(join(root, 'client/public'), { etag: false, lastModified: false, setHeaders: res => res.setHeader('Cache-Control', 'no-store') }));
// `root` keeps a dot-directory in the checkout's own path (a worktree under .claude/) from being refused.
runtime.app.get('/', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile('index.html', { root: join(root, 'client') }); });
const server = runtime.app.listen(port, '127.0.0.1', () => {
  if (!showcase) return console.log(`preview (scripted fixture, no engine): http://127.0.0.1:${port}`);
  // The staged chats are made through the adapter's own routes, like an owner would make them.
  seedShowcase({ native, base: `http://127.0.0.1:${port}` }).then(scene => {
    plays = scene.plays;
    console.log(`showcase (staged chats on the scripted fixture, no engine): http://127.0.0.1:${port}  ·  guide: http://127.0.0.1:${port}/tour/`);
  }).catch(error => { console.error('[showcase] could not stage the chats:', error); process.exitCode = 1; close(); });
});
const close = () => { void runtime.close().finally(() => server.close(() => { rmSync(dir, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); })); };
// Started by another program (a test) with PREVIEW_PARENT=stdin: when that program goes away, however it ends, so does this.
if (process.env.PREVIEW_PARENT === 'stdin') process.stdin.on('end', close).on('error', close).resume();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, close);
