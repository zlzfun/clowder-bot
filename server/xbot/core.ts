import express, { type Response } from 'express';
import { messageDisplayText, replyEnding, replyInProgress, rosterRefusals } from '../native/message-presentation.js';
import { liveEvent } from '../native/live.js';
import { clip } from '../native/text.js';
import { messageBlocks } from '../native/blocks.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { BotBridge, encode } from '../native/bridge.js';
import type { NativeCat } from '../native/types.js';
import { agentBinding } from '../native/agents.js';
import { catConfigSchema, catConfiguration, sourceTemplateSchema } from '../native/cat-templates.js';

// The version shown in 关于 is the package's, read once.
const version: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const label = z.string().trim().min(1).max(64).regex(/^[\p{L}\p{N}_ .-]+$/u, '名字包含不支持的字符');
const seed = z.string().min(1).max(80).regex(/^[^<>\x00-\x1f\x7f]+$/);
const botBody = { name: label, persona: z.string().max(32768).optional(), description: z.string().max(500).optional(),
  avatar_seed: seed.optional(), templateId: z.string().optional(), timezone: z.string().max(80).optional(),
  runtimeId: z.string().max(100).optional(), catConfig: catConfigSchema.optional(),
  sourceTemplate: sourceTemplateSchema.optional(), idempotencyKey: z.string().uuid().optional() };
// The eight portraits of client/public/cat-avatars.js.
const faces = ['ragdoll', 'maine-coon', 'siamese', 'turkish-van', 'dsh', 'dragon-li', 'bengal', 'golden-chinchilla'] as const;
const simpleCat = z.object({ face: z.enum(faces).optional(), about: z.string().trim().max(2000).optional(), agent: z.string().min(1).max(100).optional() }).strict();
// A group's name is a native thread title, free text unlike a cat's @-mentionable name.
const groupTitle = z.string().trim().min(1).max(64).regex(/^[^<>\x00-\x1f\x7f]+$/, '名字包含不支持的字符');
const sse = (res: Response, event: string, data: unknown) => {
  if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};
export function createXbotCoreRouter(bridge: BotBridge) {
  const { store, native } = bridge;
  const router = express.Router();
  const streams = new Set<Response>();
  const bot = (name: string) => bridge.cat(name);
  const direct = async (name: string) => bridge.direct(await bot(name));
  const panel = async (cat: NativeCat) => {
    const thread = await bridge.direct(cat);
    const [memory, queue, runtimes] = await Promise.all([bridge.notes(thread.id), bridge.queue(thread.id), bridge.runtimes()]);
    return { ...bridge.botItem(cat), persona: cat.roleDescription, timezone: store.bot(cat.id).timezone ?? 'Asia/Shanghai',
      agent: agentBinding(cat, runtimes), persona_card: null, memory, routines: [],
      cat_config: catConfiguration(cat, runtimes), source_template: store.bot(cat.id).sourceTemplate ?? null,
      agents: queue.activeInvocations.map(i => ({ id: i.invocationId ?? i.catId, type: 'agent', status: i.status ?? 'running', task: '正在处理', mode: 'chat', steps: 0, started_at: i.startedAt ? new Date(i.startedAt).toISOString() : '', native: i })),
      native: { cat, thread, queue }, memory_description: '会话共享笔记。长期记忆由 Clowder AI 原生记忆系统管理。' };
  };
  router.get('/session', async (_req, res) => {
    await native.request('/api/health');
    res.json({ authed: true, owner: 'local', owner_name: '你', app: false, version, tip: '', remote: false, engine: 'clowder-ai' });
  });
  router.get('/bots', async (_req, res) => res.json({ bots: (await bridge.cats()).map(cat => bridge.botItem(cat)) }));
  router.get('/bots/status', async (_req, res) => res.json(await bridge.statuses()));
  router.get('/status', async (_req, res) => res.json(await bridge.statuses()));
  router.get('/groups', async (_req, res) => {
    const cats = await bridge.cats();
    const folders = store.state.folders.map(name => ({ name, bots: cats.filter(c => store.bot(c.id).folder === name).map(c => c.name), ungrouped: false }));
    const ungrouped = cats.filter(c => !store.bot(c.id).folder).map(c => c.name);
    const groups = await Promise.all(store.state.groupThreadIds.map(id => bridge.group(id)));
    res.json({ order: store.state.folders, folders: [...folders.map(f => ({ ...f, count: f.bots.length })), { name: '', bots: ungrouped, count: ungrouped.length, ungrouped: true }], groups: groups.map(t => bridge.groupItem(t, cats)) });
  });
  router.get('/notes', (_req, res) => res.json({ notes: [] }));
  router.post('/notes/read', (_req, res) => res.json({ status: 'ok' }));
  router.get('/bots/:name/transcript', async (req, res) => res.json(await bridge.transcript(await bot(req.params.name), typeof req.query.before === 'string' ? req.query.before : undefined)));
  router.post('/bots/:name/greeting', async (req, res) => {
    const { expectedThreadId } = z.object({ expectedThreadId: z.string().min(1).max(100) }).strict().parse(req.body);
    res.json(await bridge.greet(await bot(req.params.name), expectedThreadId));
  });
  router.get('/bots/:name/steps', async (req, res) => {
    const thread = await direct(req.params.name), page = await bridge.messages(thread.id);
    res.json({ steps: page.messages.flatMap(m => (m.toolEvents ?? []).map(event => ({ time: new Date(m.timestamp).toISOString(), tool: 'Clowder AI', summary: JSON.stringify(event), native: event }))) });
  });
  router.get('/bots/:name/todos', async (req, res) => {
    const thread = await direct(req.params.name);
    const progress = await native.request(`/api/threads/${encode(thread.id)}/task-progress`);
    res.json({ items: [], native: progress, supported: false, reason: '任务进展请在原生运行面板查看' });
  });
  router.get('/bots/:name', async (req, res) => res.json(await panel(await bot(req.params.name))));
  router.get('/groups/:id', async (req, res) => {
    const thread = await bridge.group(req.params.id);
    const [cats, page] = await Promise.all([bridge.cats(), bridge.messages(thread.id, typeof req.query.before === 'string' ? req.query.before : undefined)]);
    const first = page.messages[0];
    // A cat that was addressed but is not in this group: said once by name instead of the engine's raw refusal lines.
    const refusals = rosterRefusals(page.messages, id => cats.find(cat => cat.id === id)?.name, true);
    res.json({ group: bridge.groupItem(thread, cats), hasMore: page.hasMore,
      // The cursor for the page before this one, as the single-chat transcript gives it.
      before: first ? `${first.timelineOrderAt ?? first.timestamp}:${first.id}` : null,
      messages: bridge.presentMessages(page.messages.filter(m => refusals.get(m.id) !== null), cats).map(({ message: m, name, ...presentation }) => {
        const rich = m.type === 'user' ? { blocks: [], hidden: 0 } : messageBlocks(m), refusal = refusals.get(m.id);
        return { id: m.id, time: new Date(m.timestamp).toISOString(), sender: m.type === 'user' ? 'local' : name,
          kind: m.type === 'user' ? 'person' : 'bot', text: refusal ?? messageDisplayText(m, thread.id, presentation.speaker?.name), ...(refusal ? { notice: true } : {}),
          status: m.lifecycle?.status ?? (m.isDraft ? 'processing' : 'complete'), ...(replyInProgress(m) ? { in_progress: true } : {}),
          ...(replyEnding(m) ? { ended: replyEnding(m) } : {}),
          attachments: bridge.workspaces.messageFiles(thread.id, m),
          ...(rich.blocks.length ? { blocks: rich.blocks } : {}), ...(rich.hidden ? { blocks_hidden: rich.hidden } : {}), ...presentation, native: m };
      }).filter(m => m.native.type !== 'assistant' || !!m.text.trim() || m.attachments.length > 0 || m.presentation_kind === 'activity'
        || 'in_progress' in m || 'blocks' in m || 'blocks_hidden' in m) });
  });
  router.post('/bots', async (req, res) => {
    const input = z.object({ ...botBody, simple: simpleCat.optional() }).strict().superRefine((value, ctx) => {
      if ((value.catConfig || value.simple) && !value.idempotencyKey) ctx.addIssue({ code: 'custom', path: ['idempotencyKey'], message: '创建猫猫需要请求标识' });
    }).parse(req.body);
    const cat = await bridge.createBot(input);
    res.status(201).json({ name: cat.name, native_id: cat.id });
  });
  router.patch('/bots/:name', async (req, res) => {
    const cat = await bot(req.params.name);
    const input = z.object({ ...botBody, name: label.optional(), group: z.string().max(80).optional() }).omit({ runtimeId: true, templateId: true, catConfig: true, sourceTemplate: true, idempotencyKey: true }).strict().parse(req.body);
    if (input.group && !store.state.folders.includes(input.group)) throw new ApiError(400, '分组不存在');
    if (input.name && (await bridge.cats()).some(c => c.id !== cat.id && c.name.toLowerCase() === input.name!.toLowerCase())) throw new ApiError(409, '已经有一只叫这个名字的猫猫了');
    const update: Record<string, unknown> = {};
    if (input.name) Object.assign(update, { name: input.name, displayName: input.name, nickname: input.name, mentionPatterns: [`@${input.name}`, `@${cat.id}`] });
    if (input.persona !== undefined) update.roleDescription = z.string().trim().min(1).parse(input.persona);
    if (input.description !== undefined) update.teamStrengths = input.description;
    if (Object.keys(update).length) await native.request(`/api/cats/${encode(cat.id)}`, { method: 'PATCH', body: { ...update, expectedRevision: cat.configurationRevision } });
    const meta = store.bot(cat.id);
    if (input.group !== undefined) meta.folder = input.group;
    if (input.timezone !== undefined) meta.timezone = input.timezone;
    if (input.avatar_seed !== undefined) { meta.avatarSeed = input.avatar_seed; delete meta.avatarData; delete meta.avatarMime; }
    store.save(); res.json({ name: input.name ?? cat.name });
  });
  router.post('/bots/:name/pin', async (req, res) => { const cat = await bot(req.params.name); store.bot(cat.id).pinned = z.object({ pinned: z.boolean() }).parse(req.body).pinned; store.save(); res.json({ status: 'ok' }); });
  router.post('/bots/:name/fork', async (req, res) => {
    const input = z.object({ name: label, role: z.string().min(1).max(32768), group: z.string().max(80).optional() }).strict().parse(req.body);
    if (input.group && !store.state.folders.includes(input.group)) throw new ApiError(400, '分组不存在');
    const cat = await bridge.createBot({ name: input.name, persona: input.role }, await bot(req.params.name));
    store.bot(cat.id).folder = input.group; store.save(); res.json({ name: cat.name });
  });
  router.delete('/bots/:name', async (req, res) => {
    const cat = await bot(req.params.name);
    await native.request(`/api/cats/${encode(cat.id)}`, { method: 'DELETE' });
    delete store.state.bots[cat.id]; store.save(); res.json({ status: 'ok', history: 'preserved_by_clowder_ai' });
  });
  router.post('/groups', async (req, res) => {
    const input = z.object({ name: groupTitle.optional(), members: z.array(z.string()).min(2).max(10).optional(), projectId: z.string().optional(),
      idempotencyKey: z.uuid().optional() }).strict().parse(req.body);
    if (input.projectId) throw new ApiError(410, '新群聊会自动分配文件目录，无需关联项目');
    if (!input.members) {
      const folder = label.parse(input.name);
      if (store.state.folders.includes(folder)) throw new ApiError(409, '分组已存在');
      store.state.folders.push(folder); store.save(); return res.json({ name: folder });
    }
    const members = await Promise.all(input.members.map(name => bot(name)));
    if (new Set(members.map(c => c.id)).size !== members.length) throw new ApiError(400, '成员不能重复');
    // The key names both the group's directory and the native thread creation, so sending the same
    // request again (an answer that got lost) arrives at the same group instead of making a second one.
    const directoryKey = input.idempotencyKey ?? randomUUID();
    // Unnamed, a group is called after its members; it can be renamed later.
    const joined = members.map(c => c.name).join('、');
    const title = input.name ?? clip(joined, 64);
    const thread = await bridge.newThread(title, members.map(c => c.id), directoryKey, await bridge.workspaces.groupPath(directoryKey));
    if (!store.state.groupThreadIds.includes(thread.id)) { store.state.groupThreadIds.push(thread.id); store.save(); }
    res.status(201).json(bridge.groupItem(thread, members));
  });
  router.patch('/groups/:name', async (req, res) => {
    const input = z.object({ name: groupTitle.optional(), members: z.array(z.string()).min(2).max(10).optional() }).strict()
      .refine(value => value.name !== undefined || value.members !== undefined, { message: '没有要修改的内容' }).parse(req.body);
    const index = store.state.folders.indexOf(req.params.name);
    if (index >= 0) {
      if (input.members) throw new ApiError(400, '分组没有成员设置');
      const name = label.parse(input.name);
      if (store.state.folders.includes(name) && name !== req.params.name) throw new ApiError(409, '分组已存在');
      store.state.folders[index] = name;
      for (const meta of Object.values(store.state.bots)) if (meta.folder === req.params.name) meta.folder = name;
      store.save(); return res.json({ name });
    }
    // A group chat: its name is the native thread title, its members the native preferredCats.
    const thread = await bridge.group(req.params.name), update: Record<string, unknown> = {};
    if (input.name !== undefined) update.title = input.name;
    if (input.members) {
      const members = await Promise.all(input.members.map(name => bot(name)));
      if (new Set(members.map(c => c.id)).size !== members.length) throw new ApiError(400, '成员不能重复');
      const kept = new Set(members.map(c => c.id)), leaving = (thread.preferredCats ?? []).filter(id => !kept.has(id));
      if (leaving.length) {
        // Leaving the group does not stop what a cat is doing there; say so instead of pretending it did.
        const work = await bridge.queue(thread.id);
        const busy = leaving.find(id => work.activeInvocations.some(i => i.catId === id)
          || work.queue.some(entry => entry.targetCatId === id || entry.targetCats?.includes(id)));
        if (busy) throw new ApiError(409, '有猫猫还在这个群里处理事情，等它做完或先停止，再把它移出');
      }
      update.preferredCats = members.map(c => c.id);
    }
    await native.request(`/api/threads/${encode(thread.id)}`, { method: 'PATCH', body: update });
    res.json({ ...bridge.groupItem(await bridge.thread(thread.id), await bridge.cats()), name: input.name ?? thread.title ?? '群聊' });
  });
  router.delete('/groups/:name', async (req, res) => {
    if (store.state.folders.includes(req.params.name)) {
      store.state.folders = store.state.folders.filter(n => n !== req.params.name);
      for (const meta of Object.values(store.state.bots)) if (meta.folder === req.params.name) delete meta.folder;
    } else {
      const thread = await bridge.group(req.params.name);
      await native.request(`/api/threads/${encode(thread.id)}`, { method: 'DELETE' });
      store.state.groupThreadIds = store.state.groupThreadIds.filter(id => id !== thread.id);
    }
    store.save(); res.json({ status: 'ok' });
  });
  const validateAvatar = (bytes: Buffer, mime: string) => {
    if (bytes.length > 2 * 1024 * 1024 || bytes.length < 12) throw new ApiError(400, '头像必须是 2 MB 以内的有效图片');
    const valid = (mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      || (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
      || (mime === 'image/gif' && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString()))
      || (mime === 'image/webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP');
    if (!valid) throw new ApiError(415, '只支持 PNG、JPEG、GIF 和 WebP 图片');
  };
  router.get('/bots/:name/avatar', async (req, res) => {
    const meta = store.bot((await bot(req.params.name)).id);
    if (!meta.avatarData) throw new ApiError(404, '这只猫猫用的是自带的头像');
    res.set({ 'Content-Type': meta.avatarMime!, 'X-Content-Type-Options': 'nosniff' }).send(Buffer.from(meta.avatarData, 'base64'));
  });
  router.post('/bots/:name/avatar', express.raw({ type: 'multipart/form-data', limit: '3mb' }), async (req, res) => {
    const cat = await bot(req.params.name);
    const boundary = req.headers['content-type']?.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.slice(1).find(Boolean);
    if (!boundary || boundary.length > 200 || !Buffer.isBuffer(req.body)) throw new ApiError(400, '需要上传头像文件');
    const marker = Buffer.from(`--${boundary}`), bytes = req.body as Buffer;
    let start = bytes.indexOf(marker), avatar: Buffer | undefined, mime = '';
    while (start >= 0) {
      const headEnd = bytes.indexOf(Buffer.from('\r\n\r\n'), start), next = bytes.indexOf(marker, start + marker.length);
      if (headEnd < 0 || next < 0) break;
      const head = bytes.subarray(start + marker.length, headEnd).toString('utf8');
      if (/name="file"/.test(head)) { avatar = bytes.subarray(headEnd + 4, next - 2); mime = head.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() ?? ''; break; }
      start = next;
    }
    if (!avatar) throw new ApiError(400, '未收到头像文件');
    validateAvatar(avatar, mime);
    Object.assign(store.bot(cat.id), { avatarData: avatar.toString('base64'), avatarMime: mime, avatarUpdated: Date.now() });
    store.save(); res.json({ avatar: 'custom', avatar_seed: bridge.botItem(cat).avatar_seed });
  });
  router.delete('/bots/:name/avatar', async (req, res) => {
    const cat = await bot(req.params.name), meta = store.bot(cat.id);
    delete meta.avatarData; delete meta.avatarMime; delete meta.avatarUpdated; delete meta.avatarSeed;
    store.save(); res.json({ avatar: 'generated', avatar_seed: bridge.botItem(cat).avatar_seed });
  });
  router.get('/bots/:name/template', async (req, res) => {
    const cat = await bot(req.params.name), meta = store.bot(cat.id);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encode(cat.name)}.json`);
    res.json({ name: cat.name, description: cat.teamStrengths ?? '', persona: cat.roleDescription, timezone: meta.timezone ?? 'Asia/Shanghai', avatar: meta.avatarData ?? '', avatar_mime: meta.avatarMime ?? '', avatar_seed: bridge.botItem(cat).avatar_seed, routines: [], templateId: bridge.botItem(cat).templateId });
  });
  router.post('/bots/import', async (req, res) => {
    const input = z.object({ ...botBody, avatar: z.string().max(3_000_000).optional(), avatar_mime: z.string().max(80).optional(), routines: z.array(z.unknown()).max(100).optional() }).strict().parse(req.body);
    if (input.routines?.length) throw new ApiError(422, '定时任务需要通过 Clowder AI 原生调度配置导入');
    if (input.avatar) validateAvatar(Buffer.from(input.avatar, 'base64'), input.avatar_mime ?? '');
    const cat = await bridge.createBot(input);
    if (input.avatar) Object.assign(store.bot(cat.id), { avatarData: input.avatar, avatarMime: input.avatar_mime, avatarUpdated: Date.now() });
    store.save(); res.json({ name: cat.name });
  });
  router.get('/bots/:name/export', async (req, res) => {
    const cat = await bot(req.params.name), thread = await bridge.direct(cat);
    const jsonl = req.query.format === 'jsonl';
    const rows = await bridge.allMessages(thread.id);
    res.type(jsonl ? 'application/x-ndjson' : 'text/markdown');
    res.send(jsonl ? rows.map(r => JSON.stringify(r)).join('\n') : `# ${cat.name}\n\n${rows.map(r => `## ${r.type} · ${new Date(r.timestamp).toISOString()}\n\n${r.content}`).join('\n\n')}`);
  });
  for (const action of ['stop', 'cancel']) router.post(`/bots/:name/${action}`, async (req, res) => {
    const cat = await bot(req.params.name), thread = await bridge.direct(cat); res.json(await bridge.stop(thread.id));
  });
  router.post('/bots/:name/agents/:run/cancel', async (req, res) => {
    const cat = await bot(req.params.name), thread = await bridge.direct(cat), queue = await bridge.queue(thread.id);
    const run = queue.activeInvocations.find(i => i.invocationId === req.params.run || i.catId === req.params.run);
    if (!run) throw new ApiError(404, '这个任务已结束或不存在');
    res.json(await bridge.stop(thread.id, run.catId));
  });
  router.post('/groups/:id/stop', async (req, res) => res.json(await bridge.stop((await bridge.group(req.params.id)).id)));
  router.post('/bots/:name/new', async (req, res) => {
    const cat = await bot(req.params.name), thread = await bridge.workspaces.newConversation(cat);
    res.json({ status: 'ok', conversation_id: thread.id });
  });
  router.post('/bots/:name/compact', async (req, res) => {
    const cat = await bot(req.params.name), thread = await bridge.direct(cat);
    res.json(await native.request(`/api/threads/${encode(thread.id)}/sessions/${encode(cat.id)}/compact-native`, { method: 'POST', body: {} }));
  });
  router.get('/bots/:name/memory', async (req, res) => res.json({ memory: await bridge.notes((await direct(req.params.name)).id) }));
  router.post('/bots/:name/memory', async (req, res) => {
    const input = z.object({ text: z.string().trim().min(1).max(10000), scope: z.literal('conversation').default('conversation') }).strict().parse(req.body);
    const thread = await direct(req.params.name), key = `note-${randomUUID()}`;
    await native.request('/api/memory', { method: 'POST', body: { threadId: thread.id, key, value: input.text, updatedBy: 'user' } });
    res.status(201).json({ id: key, scope: 'conversation', text: input.text });
  });
  router.delete('/bots/:name/memory/:memoryId', async (req, res) => {
    const thread = await direct(req.params.name);
    await native.request(`/api/memory?${new URLSearchParams({ threadId: thread.id, key: req.params.memoryId })}`, { method: 'DELETE' });
    res.json({ status: 'ok' });
  });
  router.get('/bots/:name/context', async (req, res) => {
    const cat = await bot(req.params.name), thread = await bridge.direct(cat);
    res.json({ ceiling: cat.resolvedContext?.windowTokens ?? 0, target: cat.resolvedContext?.inputCeilingTokens ?? 0, requests: [], detail: null,
      native: await native.request(`/api/threads/${encode(thread.id)}/sessions?catId=${encode(cat.id)}`), reason: '原生会话与用量请在运行面板查看；未估算或伪造 Token 消耗。' });
  });
  router.get('/bots/:name/peers/:peer/messages', async (req, res) => {
    const [left, right, cats] = await Promise.all([bot(req.params.name), bot(req.params.peer), bridge.cats()]);
    const threads = await Promise.all(store.state.groupThreadIds.map(id => bridge.group(id)));
    const pages = await Promise.all(threads.filter(t => t.preferredCats?.includes(left.id) && t.preferredCats.includes(right.id)).map(t => bridge.messages(t.id)));
    res.json({ messages: pages.flatMap(p => p.messages).filter(m => m.catId === left.id || m.catId === right.id).map(m => ({ id: m.id, time: new Date(m.timestamp).toISOString(), sender: cats.find(c => c.id === m.catId)?.name, kind: 'bot', text: m.content })), more: pages.some(p => p.hasMore) });
  });
  const messageBody = z.object({ text: z.string().trim().max(100000), reply_to: z.number().int().positive().optional(), images: z.array(z.string()).max(4).optional(),
    attachments: z.array(z.uuid()).max(8).optional(), expectedThreadId: z.string().min(1).optional(), idempotencyKey: z.uuid().optional(),
  }).strict().refine(v => v.text.length > 0 || !!v.attachments?.length, { message: '请填写消息或选择附件' });
  router.post('/bots/:name/messages', async (req, res) => {
    const input = messageBody.parse(req.body);
    if (input.images?.length) throw new ApiError(422, '图片请作为附件发送');
    const cat = await bot(req.params.name), thread = await bridge.direct(cat);
    const receipt = await bridge.send(thread, input, cat);
    // Native HTTP acknowledges durable admission. Do not hold a fake run open or cancel on disconnect.
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    sse(res, 'queued', receipt); sse(res, 'done', { background: true, native: receipt }); res.end();
  });
  router.post('/groups/:id/messages', async (req, res) => {
    const input = messageBody.parse(req.body);
    if (input.images?.length) throw new ApiError(422, '图片请作为附件发送');
    const receipt = await bridge.send(await bridge.group(req.params.id), input);
    res.status(202).json({ ...receipt, status: 'queued' });
  });
  router.get('/runtime/threads/:id/events', async (req, res) => {
    const id = req.params.id;
    await bridge.thread(id); // Native ownership read precedes joining the socket room.
    let ready = false;
    const release = await native.subscribe(id, event => {
      if (!ready) return;
      if (res.writableLength > 1_000_000) { res.end(); return; }
      sse(res, 'native', event);
      // The same event in the few fields a chat needs to draw a reply as it is written.
      const live = liveEvent(event, id);
      if (live) sse(res, 'live', live);
    });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    ready = true;
    streams.add(res); sse(res, 'native', { type: 'resync', threadId: id });
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 20_000);
    res.on('close', () => { clearInterval(heartbeat); release(); streams.delete(res); });
  });
  return { router, close: () => { for (const res of streams) res.end(); streams.clear(); } };
}
