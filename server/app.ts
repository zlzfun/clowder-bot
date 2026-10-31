import express, { type ErrorRequestHandler, type Response } from 'express';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z, ZodError } from 'zod';
import type { AgentProvider, Bot, Memory, ProviderKind } from '../shared/types.js';
import { ApiError, Orchestrator } from './orchestrator.js';
import { Store, makeBot, makeConversation, now } from './store.js';
import { createXbotCoreRouter } from './xbot/core.js';
import { createXbotSettingsRouter } from './xbot/settings.js';

const providerSchema = z.enum(['demo', 'openai', 'claude-cli', 'codex-cli', 'gemini-cli']);
const nameSchema = z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N}_ .-]+$/u, '名称只能包含文字、数字、空格和 _.-');
const botFields = { name: nameSchema.optional(), description: z.string().trim().max(500).optional(),
  persona: z.string().trim().min(1).max(12000).optional(), provider: providerSchema.optional(), model: z.string().trim().max(200).optional() };
const memberSchema = z.array(z.string().min(1).max(100)).min(1).max(12);

export function createApp(options: { dataFile?: string; provider?: (kind: ProviderKind) => AgentProvider; staticDir?: string } = {}) {
  const store = new Store(options.dataFile);
  const app = express();
  const clients = new Set<Response>();
  let xbotNotify: (event: string, data: unknown) => void = () => {};
  const orchestrator = new Orchestrator(store, (event, data) => {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      if (client.destroyed || client.writableLength > 4_000_000) { client.end(); clients.delete(client); }
      else client.write(chunk);
    }
    xbotNotify(event, data);
  }, options.provider);
  app.disable('x-powered-by');
  app.use('/api', (req, res, next) => {
    const host = req.hostname;
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return res.status(403).json({ error: '只允许本机访问' });
    const origin = req.headers.origin;
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: '拒绝跨站访问本地服务' });
    if (origin) {
      try { if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error(); }
      catch { return res.status(403).json({ error: '拒绝跨站访问本地服务' }); }
    }
    if (['POST', 'PATCH', 'PUT'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: '请求必须为 application/json' });
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const xbot = createXbotCoreRouter(store, orchestrator);
  xbotNotify = xbot.onEvent;
  app.use('/xbot-api', (req, res, next) => {
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(req.hostname)) return res.status(403).json({ error: '只允许本机访问' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: '拒绝跨站访问本地服务' });
    if (req.headers.origin) {
      try { if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(req.headers.origin).hostname)) throw new Error(); }
      catch { return res.status(403).json({ error: '拒绝跨站访问本地服务' }); }
    }
    const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || !!req.headers['transfer-encoding'];
    const avatarUpload = req.method === 'POST' && /^\/bots\/[^/]+\/avatar$/.test(req.path) && req.is('multipart/form-data');
    if (hasBody && ['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json') && !avatarUpload) return res.status(415).json({ error: '请求必须为 application/json，头像上传使用 multipart/form-data' });
    res.setHeader('Cache-Control', 'no-store'); next();
  });
  app.use('/xbot-api', express.json({ limit: '4mb' }), xbot.router, createXbotSettingsRouter(store, orchestrator));
  app.use('/xbot-api', (_req, res) => res.status(404).json({ error: '此接口尚未实现' }));
  app.use(express.json({ limit: '128kb' }));
  const ensureIdle = (conversationId: string) => {
    if (orchestrator.busy(conversationId)) throw new ApiError(409, '请先等待或停止当前回复');
  };
  const ensureName = (name: string, exceptId?: string) => {
    if (store.state.bots.some(b => b.id !== exceptId && b.name.toLowerCase() === name.toLowerCase())) throw new ApiError(409, '已有同名猫猫，请换一个名字');
  };
  const ensureMembers = (ids: string[], kind: 'direct' | 'group') => {
    if (new Set(ids).size !== ids.length) throw new ApiError(400, '聊天成员不能重复');
    if (kind === 'direct' && ids.length !== 1) throw new ApiError(400, '单聊只能有一只猫猫');
    if (kind === 'group' && ids.length < 2) throw new ApiError(400, '群聊至少需要两只猫猫');
    if (ids.some(id => !store.state.bots.some(b => b.id === id))) throw new ApiError(400, '包含未知猫猫');
  };
  app.get('/api/health', (_req, res) => res.json({ ok: true, mode: store.state.settings.mode }));
  app.get('/api/state', (_req, res) => res.json(store.snapshot()));
  app.get('/api/events', (req, res) => {
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(`retry: 1500\nevent: state\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
    clients.add(res);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20_000);
    req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
  });
  app.post('/api/bots', (req, res) => {
    const input = z.object({ templateId: z.string(), ...botFields }).strict().parse(req.body);
    if (!store.state.templates.some(t => t.id === input.templateId)) throw new ApiError(400, '未知猫猫模板');
    if (store.state.bots.length >= 100) throw new ApiError(400, '最多创建 100 只猫猫');
    const { templateId, ...fields } = input;
    const bot: Bot = { ...makeBot(templateId), ...fields };
    if (!input.name) {
      const base = bot.name;
      for (let suffix = 2; store.state.bots.some(b => b.name === bot.name); suffix++) bot.name = `${base} ${suffix}`;
    }
    ensureName(bot.name);
    store.state.bots.push(bot);
    store.state.conversations.push(makeConversation(bot.name, 'direct', [bot.id]));
    orchestrator.broadcast(); res.status(201).json(bot);
  });
  app.patch('/api/bots/:id', (req, res) => {
    const input = z.object(botFields).strict().parse(req.body);
    const bot = store.state.bots.find(b => b.id === req.params.id);
    if (!bot) throw new ApiError(404, '找不到这只猫猫');
    for (const conversation of store.state.conversations.filter(c => c.botIds.includes(bot.id))) ensureIdle(conversation.id);
    if (input.name) ensureName(input.name, bot.id);
    const oldName = bot.name;
    Object.assign(bot, input);
    for (const conversation of store.state.conversations.filter(c => c.botIds.includes(bot.id))) {
      store.sealSessions(conversation.id, 'bot-updated', bot.id);
      if (conversation.kind === 'direct' && conversation.title === oldName) conversation.title = bot.name;
    }
    orchestrator.broadcast(); res.json(bot);
  });
  app.post('/api/conversations', (req, res) => {
    const input = z.object({ title: z.string().trim().min(1).max(100).optional(), kind: z.enum(['direct', 'group']), botIds: memberSchema }).strict().parse(req.body);
    ensureMembers(input.botIds, input.kind);
    const existing = input.kind === 'direct' && store.state.conversations.find(c => c.kind === 'direct' && c.botIds[0] === input.botIds[0]);
    if (existing) return res.status(201).json(existing);
    const conversation = makeConversation(input.title ?? (input.kind === 'direct' ? store.state.bots.find(b => b.id === input.botIds[0])!.name : '新的猫猫群聊'), input.kind, input.botIds);
    store.state.conversations.push(conversation);
    orchestrator.broadcast(); res.status(201).json(conversation);
  });
  app.patch('/api/conversations/:id', (req, res) => {
    const input = z.object({ title: z.string().trim().min(1).max(100).optional(), pinned: z.boolean().optional(), botIds: memberSchema.optional() }).strict().parse(req.body);
    const conversation = orchestrator.conversation(req.params.id);
    if (input.botIds) { ensureIdle(conversation.id); ensureMembers(input.botIds, conversation.kind); store.sealSessions(conversation.id, 'members-updated'); }
    Object.assign(conversation, input, { updatedAt: now() });
    orchestrator.broadcast(); res.json(conversation);
  });
  app.delete('/api/conversations/:id', async (req, res) => {
    const conversation = orchestrator.conversation(req.params.id);
    await orchestrator.cancel(conversation.id);
    store.state.conversations = store.state.conversations.filter(c => c.id !== conversation.id);
    store.state.messages = store.state.messages.filter(m => m.conversationId !== conversation.id);
    store.state.memories = store.state.memories.filter(m => m.conversationId !== conversation.id);
    store.sessions = store.sessions.filter(s => s.conversationId !== conversation.id);
    orchestrator.broadcast(); res.json({ ok: true });
  });
  app.post('/api/conversations/:id/messages', (req, res) => {
    const input = z.object({ content: z.string().trim().min(1).max(20000), botId: z.string().optional() }).strict().parse(req.body);
    res.status(202).json({ runId: orchestrator.start(req.params.id, input.content, input.botId) });
  });
  app.post('/api/conversations/:id/cancel', async (req, res) => { await orchestrator.cancel(req.params.id); res.json({ ok: true }); });
  app.post('/api/conversations/:id/compact', async (req, res) => { res.json(await orchestrator.compact(req.params.id)); });
  app.post('/api/memories', (req, res) => {
    const input = z.object({ scope: z.enum(['shared', 'bot', 'conversation']), botId: z.string().optional(), conversationId: z.string().optional(),
      content: z.string().trim().min(1).max(4000), tags: z.array(z.string().trim().min(1).max(40)).max(10).optional() }).strict().parse(req.body);
    if (input.scope === 'bot' && !store.state.bots.some(b => b.id === input.botId)) throw new ApiError(400, '请选择记忆所属猫猫');
    if (input.scope === 'conversation' && !store.state.conversations.some(c => c.id === input.conversationId)) throw new ApiError(400, '请选择记忆所属聊天');
    if (store.state.memories.length >= 5000) throw new ApiError(400, '记忆条目已达上限，请清理旧记忆');
    const memory: Memory = store.remember({ scope: input.scope, content: input.content, tags: input.tags ?? [], source: 'user',
      ...(input.scope === 'bot' ? { botId: input.botId } : {}), ...(input.scope === 'conversation' ? { conversationId: input.conversationId } : {}) });
    orchestrator.broadcast(); res.status(201).json(memory);
  });
  app.delete('/api/memories/:id', (req, res) => {
    if (!store.state.memories.some(m => m.id === req.params.id)) throw new ApiError(404, '找不到这条记忆');
    store.state.memories = store.state.memories.filter(m => m.id !== req.params.id);
    orchestrator.broadcast(); res.json({ ok: true });
  });
  app.put('/api/settings', (req, res) => {
    const input = z.object({ mode: z.enum(['demo', 'live']).optional(), baseUrl: z.string().url().max(2000).optional(),
      apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]{0,99}$/).optional(), defaultModel: z.string().trim().max(200).optional(),
      contextBudget: z.number().int().min(2000).max(128000).optional(), maxHops: z.number().int().min(1).max(15).optional(),
      cliWorkingDirectory: z.string().max(2000).optional() }).strict().parse(req.body);
    if (store.state.conversations.some(c => orchestrator.busy(c.id))) throw new ApiError(409, '请先停止正在进行的回复，再修改设置');
    if (input.baseUrl) {
      const url = new URL(input.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ApiError(400, '服务地址必须是无凭据、查询或片段的 HTTP(S) URL');
    }
    if (input.cliWorkingDirectory && (!isAbsolute(input.cliWorkingDirectory) || !existsSync(input.cliWorkingDirectory) || !statSync(input.cliWorkingDirectory).isDirectory())) throw new ApiError(400, '工作目录必须是已存在的绝对目录');
    Object.assign(store.state.settings, input);
    for (const conversation of store.state.conversations) store.sealSessions(conversation.id, 'settings-updated');
    orchestrator.broadcast(); res.json(store.state.settings);
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '找不到这个接口' }));
  const staticDir = options.staticDir ?? resolve('dist/client');
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get('/{*splat}', (_req, res) => res.sendFile(resolve(staticDir, 'index.html')));
  }
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ZodError) { res.status(400).json({ error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；') }); return; }
    if (error instanceof ApiError) { res.status(error.status).json({ error: error.message }); return; }
    if (error?.type === 'entity.too.large') { res.status(413).json({ error: '请求内容过大' }); return; }
    if (error instanceof SyntaxError && 'body' in error) { res.status(400).json({ error: 'JSON 格式不正确' }); return; }
    console.error('[clowder-bot]', error);
    res.status(500).json({ error: '服务出现异常，操作未能完成。请查看服务日志。' });
  };
  app.use(errors);
  return { app, store, orchestrator, close: async () => { await orchestrator.shutdown(); xbot.close(); for (const client of clients) client.end(); clients.clear(); } };
}
