import express, { type Response } from 'express';
import { z } from 'zod';
import type { Bot, Conversation, Message } from '../../shared/types.js';
import { Store, id, makeBot, makeConversation, now } from '../store.js';
import { ApiError, Orchestrator } from '../orchestrator.js';
import { buildContext, estimateTokens, scopedMemories } from '../core/context.js';
import { applyBotPersona, personaCardSummary, resolveXbotBinding } from './settings.js';

type Meta = Record<string, any>;
const label = z.string().trim().min(1).max(64).regex(/^[\p{L}\p{N}_ .-]+$/u, '名字包含不支持的字符');
const seed = z.string().trim().min(1).max(80).regex(/^[^<>\x00-\x1f\x7f]+$/, '无效的头像种子');
export function xbotMeta(store: Store, bot: Bot): Meta {
  store.xbot.bots ??= {};
  return store.xbot.bots[bot.id] ??= {};
}
export function xbotBot(store: Store, name: string): Bot {
  const bot = store.state.bots.find(b => b.name === name);
  if (!bot) throw new ApiError(404, '找不到这个 Bot');
  return bot;
}
export function directConversation(store: Store, bot: Bot): Conversation {
  const activeId = store.xbot.bots?.[bot.id]?.activeConversationId;
  let conversation = store.state.conversations.find(c => c.id === activeId && c.kind === 'direct' && c.botIds[0] === bot.id)
    ?? store.state.conversations.find(c => c.kind === 'direct' && c.botIds[0] === bot.id);
  if (!conversation) { conversation = makeConversation(bot.name, 'direct', [bot.id]); store.state.conversations.push(conversation); store.save(); }
  return conversation;
}

export function createXbotCoreRouter(store: Store, orchestrator: Orchestrator) {
  const router = express.Router();
  const streams = new Map<string, { res: Response; conversationId: string; sent: Set<string> }>();
  const meta = (bot: Bot) => xbotMeta(store, bot);
  const avatarSeedOf = (bot: Bot) => meta(bot).avatarSeed ?? `cat:${bot.templateId}`;
  const conversationMessages = (conversation: Conversation) => store.state.messages.filter(m => m.conversationId === conversation.id);
  const direct = (bot: Bot) => directConversation(store, bot);
  const getBot = (name: string) => xbotBot(store, name);
  const group = (id: string) => {
    const conversation = store.state.conversations.find(c => c.id === id && c.kind === 'group');
    if (!conversation) throw new ApiError(404, '找不到这个群聊');
    return conversation;
  };
  const idle = (bot: Bot) => {
    if (store.state.conversations.some(c => c.botIds.includes(bot.id) && orchestrator.busy(c.id))) throw new ApiError(409, '请先停止正在进行的回复');
  };
  const ensureName = (name: string, except?: string) => {
    if (store.state.bots.some(b => b.id !== except && b.name.toLowerCase() === name.toLowerCase())) throw new ApiError(409, '已有同名 Bot');
  };
  const botItem = (bot: Bot) => {
    const m = meta(bot), conversation = direct(bot);
    return { name: bot.name, templateId: bot.templateId, persona: (m.duty ?? bot.persona).slice(0, 80), description: bot.description,
      unread: conversationMessages(conversation).length > (m.readCount ?? 0), notes: 0, pinned: conversation.pinned,
      primary: store.state.bots[0]?.id === bot.id, group: m.group ?? '', avatar: m.avatarData ? 'custom' : 'generated',
      avatar_seed: avatarSeedOf(bot), avatar_url: m.avatarData ? `/xbot-api/bots/${encodeURIComponent(bot.name)}/avatar?v=${m.avatarUpdated ?? ''}` : '',
      avatar_bg: '', avatar_ink: '', initial: bot.name.slice(0, 1) };
  };
  const groupItem = (conversation: Conversation) => ({ id: conversation.id, name: conversation.title,
    members: conversation.botIds.map(id => store.state.bots.find(b => b.id === id)?.name).filter(Boolean), created: conversation.createdAt });
  const agentRows = (bot: Bot) => store.state.conversations.filter(c => c.botIds.includes(bot.id) && c.status === 'running').map(c => {
    const run = conversationMessages(c).findLast(m => !!m.runId);
    return { id: run?.runId ?? c.id, type: 'agent', status: 'running', task: conversationMessages(c).findLast(m => m.role === 'user')?.content ?? '整理上下文',
      mode: 'chat', steps: 0, started_at: run?.createdAt ?? c.updatedAt, current_step: '', notable: [], summary: '' };
  });
  const botPanel = (bot: Bot) => {
    const m = meta(bot);
    const effectiveProvider = m.runtimeProvider ?? (store.state.settings.mode === 'demo' ? 'demo' : bot.provider);
    return { ...botItem(bot), persona: m.duty ?? bot.persona, timezone: m.timezone ?? 'Asia/Shanghai',
      provider: effectiveProvider, model: bot.model || (effectiveProvider === 'openai' ? store.state.settings.defaultModel : '') || 'default',
      persona_card: personaCardSummary(store, bot),
      memory: scopedMemories(store.state, bot.id, direct(bot).id).map(memory => ({ id: memory.id, scope: memory.scope === 'shared' ? 'person' : memory.scope, text: memory.content })),
      routines: [], agents: agentRows(bot) };
  };
  const transcript = (bot: Bot) => {
    const rows: Meta[] = [];
    const conversation = direct(bot);
    const messages = conversationMessages(conversation);
    const replyIds = store.xbot.replyTo ?? {};
    for (const message of messages) {
      if (message.status === 'streaming') continue;
      const base = { seq: rows.length + 1, content: message.content, name: bot.name, time: message.createdAt, reply_to: replyIds[message.id] ?? 0, status: message.status };
      if (message.role === 'user') rows.push({ ...base, role: 'user' });
      else if (message.content) {
        // XBot's original renderer deliberately shows only delivered owner-chat
        // calls. These are delivery receipts for existing messages, not model tools.
        const callId = `delivery_${message.id}`;
        rows.push({ ...base, role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: 'send_message_to_user', arguments: JSON.stringify({ text: message.content }) } }] });
        rows.push({ seq: rows.length + 1, role: 'tool', name: 'send_message_to_user', content: "sent to the owner's chat", tool_call_id: callId, time: message.createdAt });
      }
    }
    return rows;
  };
  router.get('/session', (_req, res) => res.json({ authed: true, owner: 'local', owner_name: '你', app: false, version: '0.1.0', tip: '', remote: false, needs_key: false }));
  router.get('/bots', (_req, res) => res.json({ bots: store.state.bots.map(botItem) }));
  router.get('/bots/status', (_req, res) => res.json({ bots: store.state.bots.map(bot => {
    const tasks = agentRows(bot), current = tasks[0];
    const conversation = store.state.conversations.find(c => c.activeBotId === bot.id && c.status === 'running');
    return { bot: bot.name, state: conversation ? 'running' : current ? 'running' : 'idle', since: current?.started_at,
      task: current?.task ?? '', todo: '', tool: '', tool_summary: '', completed_unread: 0 };
  }), others: [] }));
  router.get('/groups', (_req, res) => {
    const names: string[] = store.xbot.folders ?? [];
    const folders = names.map(name => ({ name, bots: store.state.bots.filter(b => meta(b).group === name).map(b => b.name), ungrouped: false }));
    const ungrouped = store.state.bots.filter(b => !meta(b).group).map(b => b.name);
    res.json({ order: names, folders: [...folders.map(f => ({ ...f, count: f.bots.length })), { name: '', bots: ungrouped, count: ungrouped.length, ungrouped: true }], groups: store.state.conversations.filter(c => c.kind === 'group').map(groupItem) });
  });
  router.get('/notes', (_req, res) => res.json({ notes: [] }));
  router.post('/notes/read', (req, res) => { if (req.body?.bot) { const bot = getBot(req.body.bot); meta(bot).readCount = conversationMessages(direct(bot)).length; store.save(); } res.json({ status: 'ok' }); });
  router.get('/bots/:name/transcript', (req, res) => { const bot = getBot(req.params.name); const messages = transcript(bot); meta(bot).readCount = conversationMessages(direct(bot)).length; store.save(); res.json({ messages }); });
  router.get('/bots/:name/steps', (req, res) => { const bot = getBot(req.params.name); res.json({ steps: conversationMessages(direct(bot)).filter(m => m.role === 'assistant').slice(-20).map(m => ({ time: m.createdAt, tool: 'reply', summary: m.content.slice(0, 160), status: m.status, duration: 0 })) }); });
  router.get('/bots/:name/todos', (req, res) => { getBot(req.params.name); res.json({ items: [] }); });
  router.get('/bots/:name', (req, res) => res.json(botPanel(getBot(req.params.name))));
  router.get('/groups/:id', (req, res) => {
    const conversation = group(req.params.id);
    res.json({ group: groupItem(conversation), messages: conversationMessages(conversation).filter(m => m.status !== 'streaming').map(m => ({ id: m.id, time: m.createdAt, sender: m.role === 'user' ? 'local' : store.state.bots.find(b => b.id === m.botId)?.name ?? '系统', kind: m.role === 'user' ? 'person' : 'bot', text: m.role === 'system' ? `[action] ${m.content}` : m.content })) });
  });
  const createBot = (input: { name: string; persona?: string; description?: string; avatar_seed?: string; templateId?: string; timezone?: string }, source?: Bot) => {
    ensureName(input.name);
    if (store.state.bots.length >= 100) throw new ApiError(400, '最多创建 100 个 Bot');
    const templateId = input.templateId ?? source?.templateId ?? 'ragdoll';
    if (!store.state.templates.some(t => t.id === templateId)) throw new ApiError(400, '未知模板');
    const bot = { ...makeBot(templateId), name: input.name, description: input.description ?? source?.description ?? '' };
    if (source) { bot.provider = source.provider; bot.model = source.model; }
    store.state.bots.push(bot);
    const info = meta(bot);
    info.runtimeProvider = source ? meta(source).runtimeProvider ?? (store.state.settings.mode === 'demo' ? 'demo' : source.provider) : 'demo';
    if (input.avatar_seed) info.avatarSeed = input.avatar_seed;
    if (input.timezone) info.timezone = input.timezone;
    if (source) info.personaCard = meta(source).personaCard;
    applyBotPersona(store, bot, input.persona?.trim() || (source ? meta(source).duty ?? source.persona : bot.persona));
    store.state.conversations.push(makeConversation(bot.name, 'direct', [bot.id]));
    return bot;
  };
  const botBody = { name: label, persona: z.string().max(32768).optional(), description: z.string().max(500).optional(),
    avatar_seed: seed.optional(), templateId: z.string().optional(), timezone: z.string().max(80).optional() };
  router.post('/bots', (req, res) => { const bot = createBot(z.object(botBody).strict().parse(req.body)); orchestrator.broadcast(); res.json({ name: bot.name }); });
  router.patch('/bots/:name', (req, res) => {
    const bot = getBot(req.params.name); idle(bot);
    const input = z.object({ ...botBody, name: label.optional(), group: z.string().trim().max(80).optional() }).strict().parse(req.body);
    if (input.name) ensureName(input.name, bot.id);
    if (input.group && !(store.xbot.folders ?? []).includes(input.group)) throw new ApiError(400, '分组不存在');
    if (input.persona !== undefined && !input.persona.trim()) throw new ApiError(400, '职责不能为空');
    const m = meta(bot), before = bot.name;
    if (input.name) bot.name = input.name;
    if (input.description !== undefined) bot.description = input.description;
    if (input.persona !== undefined) applyBotPersona(store, bot, input.persona);
    if (input.timezone !== undefined) m.timezone = input.timezone;
    if (input.group !== undefined) m.group = input.group;
    if (input.avatar_seed !== undefined) { m.avatarSeed = input.avatar_seed; delete m.avatarData; delete m.avatarMime; }
    for (const conversation of store.state.conversations.filter(c => c.botIds.includes(bot.id))) {
      store.sealSessions(conversation.id, 'profile-updated', bot.id);
      if (conversation.kind === 'direct' && conversation.title === before) conversation.title = bot.name;
    }
    orchestrator.broadcast(); res.json({ name: bot.name });
  });
  router.put('/bots/:name/binding', (req, res) => {
    const bot = getBot(req.params.name); idle(bot);
    const input = z.object({ provider: z.string(), model: z.string().max(200) }).strict().parse(req.body);
    const binding = resolveXbotBinding(store, input.provider, input.model);
    Object.assign(bot, binding); meta(bot).runtimeProvider = binding.provider;
    for (const conversation of store.state.conversations.filter(c => c.botIds.includes(bot.id))) store.sealSessions(conversation.id, 'provider-updated', bot.id);
    orchestrator.broadcast(); res.json({ name: bot.name, provider: binding.provider, model: binding.model || 'default' });
  });
  router.post('/bots/:name/pin', (req, res) => { const bot = getBot(req.params.name); direct(bot).pinned = z.object({ pinned: z.boolean() }).parse(req.body).pinned; orchestrator.broadcast(); res.json({ status: 'ok' }); });
  router.post('/bots/:name/fork', (req, res) => {
    const source = getBot(req.params.name);
    const input = z.object({ name: label, role: z.string().trim().min(1).max(12000), group: z.string().trim().max(80).optional() }).strict().parse(req.body);
    if (input.group && !(store.xbot.folders ?? []).includes(input.group)) throw new ApiError(400, '分组不存在');
    const bot = createBot({ name: input.name, persona: input.role }, source);
    if (input.group) meta(bot).group = input.group;
    orchestrator.broadcast(); res.json({ name: bot.name });
  });
  router.delete('/bots/:name', async (req, res) => {
    const bot = getBot(req.params.name);
    const affected = store.state.conversations.filter(c => c.botIds.includes(bot.id));
    for (const conversation of affected) await orchestrator.cancel(conversation.id);
    const remove = new Set(affected.filter(c => c.kind === 'direct' || c.botIds.length <= 2).map(c => c.id));
    for (const conversation of affected) if (!remove.has(conversation.id)) conversation.botIds = conversation.botIds.filter(id => id !== bot.id);
    store.state.bots = store.state.bots.filter(b => b.id !== bot.id);
    store.state.conversations = store.state.conversations.filter(c => !remove.has(c.id));
    store.state.messages = store.state.messages.filter(m => !remove.has(m.conversationId));
    store.state.memories = store.state.memories.filter(m => m.botId !== bot.id && !remove.has(m.conversationId ?? ''));
    store.sessions = store.sessions.filter(s => s.botId !== bot.id && !remove.has(s.conversationId));
    delete store.xbot.bots?.[bot.id]; delete store.xbot.contexts?.[bot.id];
    orchestrator.broadcast(); res.json({ status: 'ok' });
  });
  router.post('/groups', (req, res) => {
    const input = z.object({ name: z.string().trim().min(1).max(80), members: z.array(z.string()).min(2).max(12).optional() }).strict().parse(req.body);
    if (!input.members) {
      store.xbot.folders ??= [];
      if (store.xbot.folders.includes(input.name)) throw new ApiError(409, '分组已存在');
      store.xbot.folders.push(input.name); orchestrator.broadcast(); res.json({ name: input.name }); return;
    }
    if (new Set(input.members).size !== input.members.length) throw new ApiError(400, '成员不能重复');
    const members = input.members.map(getBot);
    const conversation = makeConversation(input.name, 'group', members.map(b => b.id));
    store.state.conversations.push(conversation); orchestrator.broadcast(); res.json(groupItem(conversation));
  });
  router.patch('/groups/:name', (req, res) => {
    const input = z.object({ name: z.string().trim().min(1).max(80) }).strict().parse(req.body);
    const folders: string[] = store.xbot.folders ?? [];
    const index = folders.indexOf(req.params.name);
    if (index < 0) { const conversation = group(req.params.name); conversation.title = input.name; }
    else {
      if (folders.some((name, i) => i !== index && name === input.name)) throw new ApiError(409, '已有同名分组');
      folders[index] = input.name;
      for (const bot of store.state.bots) if (meta(bot).group === req.params.name) meta(bot).group = input.name;
    }
    orchestrator.broadcast(); res.json({ name: input.name });
  });
  router.delete('/groups/:name', async (req, res) => {
    if ((store.xbot.folders ?? []).includes(req.params.name)) {
      store.xbot.folders = store.xbot.folders.filter((name: string) => name !== req.params.name);
      for (const bot of store.state.bots) if (meta(bot).group === req.params.name) meta(bot).group = '';
    } else {
      const conversation = group(req.params.name); await orchestrator.cancel(conversation.id);
      store.state.conversations = store.state.conversations.filter(c => c.id !== conversation.id);
      store.state.messages = store.state.messages.filter(m => m.conversationId !== conversation.id);
      store.state.memories = store.state.memories.filter(m => m.conversationId !== conversation.id);
      store.sessions = store.sessions.filter(s => s.conversationId !== conversation.id);
    }
    orchestrator.broadcast(); res.json({ status: 'ok' });
  });
  const validateAvatar = (bytes: Buffer, mime: string) => {
    if (bytes.length > 2 * 1024 * 1024 || bytes.length < 12) throw new ApiError(400, '头像必须是 2 MB 以内的有效图片');
    const valid = (mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      || (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
      || (mime === 'image/gif' && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString()))
      || (mime === 'image/webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP');
    if (!valid) throw new ApiError(415, '只支持 PNG、JPEG、GIF 和 WebP 图片');
  };
  router.get('/bots/:name/avatar', (req, res) => {
    const m = meta(getBot(req.params.name));
    if (!m.avatarData) throw new ApiError(404, '这个 Bot 使用生成的头像');
    res.set({ 'Content-Type': m.avatarMime, 'X-Content-Type-Options': 'nosniff' }).send(Buffer.from(m.avatarData, 'base64'));
  });
  router.post('/bots/:name/avatar', express.raw({ type: 'multipart/form-data', limit: '3mb' }), (req, res) => {
    const bot = getBot(req.params.name);
    const boundary = req.headers['content-type']?.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.slice(1).find(Boolean);
    if (!boundary || boundary.length > 200 || !Buffer.isBuffer(req.body)) throw new ApiError(400, '需要上传头像文件');
    const marker = Buffer.from(`--${boundary}`), bytes = req.body as Buffer;
    let start = bytes.indexOf(marker), avatar: Buffer | undefined, mime = '';
    while (start >= 0) {
      const headEnd = bytes.indexOf(Buffer.from('\r\n\r\n'), start);
      const next = bytes.indexOf(marker, start + marker.length);
      if (headEnd < 0 || next < 0) break;
      const head = bytes.subarray(start + marker.length, headEnd).toString('utf8');
      if (/name="file"/.test(head)) { avatar = bytes.subarray(headEnd + 4, next - 2); mime = head.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() ?? ''; break; }
      start = next;
    }
    if (!avatar) throw new ApiError(400, '未收到头像文件');
    validateAvatar(avatar, mime);
    Object.assign(meta(bot), { avatarData: avatar.toString('base64'), avatarMime: mime, avatarUpdated: Date.now() });
    orchestrator.broadcast(); res.json({ avatar: 'custom', avatar_seed: avatarSeedOf(bot) });
  });
  router.delete('/bots/:name/avatar', (req, res) => {
    const bot = getBot(req.params.name), m = meta(bot);
    delete m.avatarData; delete m.avatarMime; delete m.avatarUpdated; delete m.avatarSeed;
    orchestrator.broadcast(); res.json({ avatar: 'generated', avatar_seed: avatarSeedOf(bot) });
  });
  router.get('/bots/:name/template', (req, res) => {
    const bot = getBot(req.params.name), m = meta(bot);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(bot.name)}.json`);
    res.json({ name: bot.name, description: bot.description, persona: m.duty ?? bot.persona, timezone: m.timezone ?? 'Asia/Shanghai',
      avatar: m.avatarData ?? '', avatar_mime: m.avatarMime ?? '', avatar_seed: avatarSeedOf(bot), routines: [], templateId: bot.templateId });
  });
  router.post('/bots/import', (req, res) => {
    const input = z.object({ ...botBody, avatar: z.string().max(3_000_000).optional(), avatar_mime: z.string().max(80).optional(),
      routines: z.array(z.unknown()).max(100).optional(), style: z.unknown().optional(), proactivity: z.string().optional(), quiet_start: z.string().optional(), quiet_end: z.string().optional() }).strict().parse(req.body);
    if (input.routines?.length) throw new ApiError(501, '此模板包含暂未接入的定时任务，请移除 routines 后导入');
    if (input.avatar) validateAvatar(Buffer.from(input.avatar, 'base64'), input.avatar_mime ?? '');
    const bot = createBot(input);
    if (input.avatar) Object.assign(meta(bot), { avatarData: input.avatar, avatarMime: input.avatar_mime, avatarUpdated: Date.now() });
    orchestrator.broadcast(); res.json({ name: bot.name });
  });
  router.get('/bots/:name/export', (req, res) => {
    const bot = getBot(req.params.name), rows = transcript(bot);
    const jsonl = req.query.format === 'jsonl';
    const selected = req.query.tools === '1' || req.query.tools === 'true' ? rows : rows.filter(row => row.role !== 'tool').map(({ tool_calls, ...row }) => row);
    res.set({ 'Content-Type': jsonl ? 'application/x-ndjson; charset=utf-8' : 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(bot.name)}.${jsonl ? 'jsonl' : 'md'}` });
    res.send(jsonl ? selected.map(row => JSON.stringify(row)).join('\n') : `# ${bot.name}\n\n${selected.map(row => `## ${row.role === 'user' ? '你' : bot.name} · ${row.time}\n\n${row.content}`).join('\n\n')}`);
  });
  const cancel = async (bot: Bot) => { for (const conversation of store.state.conversations.filter(c => c.botIds.includes(bot.id))) if (orchestrator.busy(conversation.id)) await orchestrator.cancel(conversation.id); };
  router.post('/bots/:name/stop', async (req, res) => { await cancel(getBot(req.params.name)); res.json({ status: 'ok' }); });
  router.post('/bots/:name/cancel', async (req, res) => { await cancel(getBot(req.params.name)); res.json({ status: 'ok' }); });
  router.post('/bots/:name/agents/:run/cancel', async (req, res) => {
    const bot = getBot(req.params.name);
    const task = agentRows(bot).find(row => row.id === req.params.run);
    if (!task) throw new ApiError(404, '这个任务已结束或不存在');
    await cancel(bot); res.json({ status: 'ok' });
  });
  router.post('/groups/:id/stop', async (req, res) => { await orchestrator.cancel(group(req.params.id).id); res.json({ status: 'ok' }); });
  router.post('/bots/:name/new', async (req, res) => {
    const bot = getBot(req.params.name); await cancel(bot);
    const old = direct(bot); store.sealSessions(old.id, 'new-conversation');
    const conversation = makeConversation(bot.name, 'direct', [bot.id]); store.state.conversations.push(conversation);
    meta(bot).activeConversationId = conversation.id; delete store.xbot.contexts?.[bot.id];
    orchestrator.broadcast(); res.json({ status: 'ok', conversation_id: conversation.id });
  });
  router.post('/bots/:name/compact', async (req, res) => { const bot = getBot(req.params.name); await orchestrator.compact(direct(bot).id); res.json({ status: 'ok' }); });
  router.get('/bots/:name/memory', (req, res) => { const bot = getBot(req.params.name); res.json({ memory: botPanel(bot).memory }); });
  router.post('/bots/:name/memory', (req, res) => {
    const bot = getBot(req.params.name);
    const input = z.object({ text: z.string().trim().min(1).max(4000), scope: z.enum(['person', 'shared', 'bot', 'conversation']).default('bot') }).strict().parse(req.body);
    const scope = input.scope === 'person' ? 'shared' : input.scope;
    const memory = store.remember({ scope, content: input.text, tags: [], source: 'user', ...(scope === 'bot' ? { botId: bot.id } : {}), ...(scope === 'conversation' ? { conversationId: direct(bot).id } : {}) });
    orchestrator.broadcast(); res.json({ id: memory.id, scope: input.scope, text: memory.content });
  });
  router.delete('/bots/:name/memory/:memoryId', (req, res) => {
    const bot = getBot(req.params.name);
    if (!scopedMemories(store.state, bot.id, direct(bot).id).some(m => m.id === req.params.memoryId)) throw new ApiError(404, '这条记忆不存在');
    store.state.memories = store.state.memories.filter(m => m.id !== req.params.memoryId); orchestrator.broadcast(); res.json({ status: 'ok' });
  });
  router.get('/bots/:name/context', (req, res) => {
    const bot = getBot(req.params.name);
    const recorded: Meta[] = store.xbot.contexts?.[bot.id] ?? [];
    const snapshots = recorded.map((record, index) => {
      const layers = record.messages.map((message: { role: string; content: string }, i: number) => ({
        key: message.role === 'system' ? 'sys' : message.content.includes('历史摘录（') ? 'block' : message.content.includes('相关长期记忆：') ? 'mem' : i === record.messages.length - 1 ? 'turn' : 'hist',
        tokens: estimateTokens(message.content) }));
      return { step: index + 1, prompt: record.prompt, tools: 0, layers, turn_steps: 1, time: record.time };
    });
    const last = recorded.at(-1);
    const conversation = last ? store.state.conversations.find(c => c.id === last.conversationId) ?? direct(bot) : direct(bot);
    res.json({ ceiling: store.state.settings.contextBudget, target: Math.floor(store.state.settings.contextBudget * 0.6), requests: snapshots,
      detail: last ? { steps: [{ what: '当前请求', tokens: estimateTokens(last.messages.at(-1)?.content ?? ''), preview: last.messages.at(-1)?.content ?? '' }],
        turns: last.messages.filter((m: Meta) => m.role !== 'system').slice(0, -1).map((m: Meta) => ({ ask: m.content.slice(0, 100), tokens: estimateTokens(m.content) })),
        blocks: conversation.summary ? [{ from: 1, to: conversation.compactedMessageCount, tokens: estimateTokens(conversation.summary), preview: conversation.summary }] : [], tool_defs: [] } : null });
  });
  router.get('/bots/:name/peers/:peer/messages', (req, res) => {
    const bot = getBot(req.params.name), peer = getBot(req.params.peer);
    const shared = new Set(store.state.conversations.filter(c => c.kind === 'group' && c.botIds.includes(bot.id) && c.botIds.includes(peer.id)).map(c => c.id));
    const messages = store.state.messages.filter(m => shared.has(m.conversationId) && [bot.id, peer.id].includes(m.botId ?? '') && m.role === 'assistant' && m.status === 'complete');
    res.json({ messages: messages.map(m => ({ id: m.id, time: m.createdAt, sender: store.state.bots.find(b => b.id === m.botId)?.name, kind: 'bot', text: m.content })), more: false });
  });
  const sse = (res: Response, event: string, data: unknown) => { if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const send = (conversation: Conversation, input: unknown, res: Response, streaming: boolean) => {
    const body = z.object({ text: z.string().trim().min(1).max(20000), reply_to: z.number().int().positive().optional(), images: z.array(z.string()).max(4).optional() }).strict().parse(input);
    if (body.images?.length) throw new ApiError(501, '当前模型适配尚未接入聊天图片，请先发送文字');
    if (body.reply_to && streaming) {
      const bot = store.state.bots.find(b => b.id === conversation.botIds[0])!;
      if (!transcript(bot).some(m => m.seq === body.reply_to)) throw new ApiError(400, '引用的消息不存在');
    }
    const runId = orchestrator.start(conversation.id, body.text);
    if (body.reply_to) {
      const message = store.state.messages.find(m => m.runId === runId && m.role === 'user');
      store.xbot.replyTo ??= {}; if (message) store.xbot.replyTo[message.id] = body.reply_to; store.save();
    }
    if (!streaming) { res.json({ status: 'sent', run_id: runId }); return; }
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    streams.set(runId, { res, conversationId: conversation.id, sent: new Set() });
    sse(res, 'tool', { name: 'reply', summary: '正在回复' });
    res.on('close', () => streams.delete(runId));
  };
  router.post('/bots/:name/messages', (req, res) => send(direct(getBot(req.params.name)), req.body, res, true));
  router.post('/groups/:id/messages', (req, res) => send(group(req.params.id), req.body, res, false));
  const onEvent = (event: string, data: any) => {
    for (const [runId, stream] of streams) {
      if (stream.res.destroyed) { streams.delete(runId); continue; }
      if (event === 'delta' && data.conversationId === stream.conversationId) sse(stream.res, 'part', { type: 'text', text: data.delta });
      if (event !== 'state') continue;
      const messages = store.state.messages.filter(m => m.conversationId === stream.conversationId && m.runId === runId);
      for (const message of messages) if (message.role === 'assistant' && message.status === 'complete' && !stream.sent.has(message.id)) {
        stream.sent.add(message.id); sse(stream.res, 'result', { name: 'send_message_to_user', text: message.content });
      }
      const conversation = store.state.conversations.find(c => c.id === stream.conversationId);
      if (!conversation || conversation.status !== 'running') {
        if (conversation?.status === 'error') sse(stream.res, 'error', { error: conversationMessages(conversation).findLast(m => m.role === 'system')?.content ?? '回复失败' });
        else sse(stream.res, 'done', { text: messages.filter(m => m.role === 'assistant').map(m => m.content).join('\n\n') });
        stream.res.end(); streams.delete(runId);
      }
    }
  };

  return { router, onEvent, close: () => { for (const stream of streams.values()) stream.res.end(); streams.clear(); } };
}
