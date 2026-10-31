import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { z } from 'zod';
import type { Bot, ProviderKind } from '../../shared/types.js';
import { Store, id, now } from '../store.js';
import { ApiError, Orchestrator } from '../orchestrator.js';

interface Card { id: string; name: string; body: string; updated: string; templateId?: string }
type Meta = Record<string, any>;
function meta(store: Store): Meta {
  const holder = store as Store & { xbot?: Meta };
  holder.xbot ??= {};
  holder.xbot.bots ??= {};
  holder.xbot.settings ??= {};
  holder.xbot.personaCards ??= store.state.templates.map(template => ({
    id: `cat-${template.id}`, templateId: template.id, name: `${template.name} · ${template.nickname}`,
    body: template.systemPrompt, updated: now(),
  }));
  return holder.xbot;
}
function botMeta(store: Store, bot: Bot): Meta { return meta(store).bots[bot.id] ??= {}; }
export function getPersonaCard(store: Store, cardId?: string): Card | undefined {
  const cards: Card[] = meta(store).personaCards;
  return cardId ? cards.find(card => card.id === cardId) : cards[0];
}
export function personaCardSummary(store: Store, bot: Bot) {
  const info = botMeta(store, bot);
  const card = getPersonaCard(store, info.personaCard ?? `cat-${bot.templateId}`) ?? getPersonaCard(store);
  return card ? { id: card.id, name: card.name, preview: card.body.split('\n').find(line => line.trim())?.slice(0, 240) ?? '' } : null;
}
export function applyBotPersona(store: Store, bot: Bot, duty?: string): void {
  const info = botMeta(store, bot);
  info.duty = duty ?? info.duty ?? bot.persona;
  const card = getPersonaCard(store, info.personaCard ?? `cat-${bot.templateId}`) ?? getPersonaCard(store);
  bot.persona = card && info.duty.trim() !== card.body.trim() ? `${info.duty}\n\n${card.body}`.trim() : card?.body ?? info.duty;
}

const providerKinds = ['demo', 'openai', 'claude-cli', 'codex-cli', 'gemini-cli'] as const;
const providerNames: Record<ProviderKind, string> = {
  demo: '本地演示', openai: 'OpenAI', 'claude-cli': 'Claude Code', 'codex-cli': 'Codex CLI', 'gemini-cli': 'Gemini CLI',
};
function providerKind(value: string): ProviderKind {
  if (!(providerKinds as readonly string[]).includes(value)) throw new ApiError(501, '此供应商尚未接入。可使用 OpenAI 兼容 API 或本机 Agent CLI。');
  return value as ProviderKind;
}
export function resolveXbotBinding(store: Store, providerName: string, model: string): { provider: ProviderKind; model: string } {
  const provider = providerKind(providerName);
  if (model.length > 200) throw new ApiError(400, '模型名称过长');
  if (provider === 'openai' && !model.trim()) throw new ApiError(400, '请选择模型');
  return { provider, model: provider === 'demo' || model === 'default' ? '' : model.trim() };
}
function modelRow(store: Store, provider: ProviderKind, model: string) {
  return { id: `${provider}/${model}`, provider, model, name: model, protocol: provider === 'openai' ? 'chat_completions' : 'local',
    brand: provider === 'openai' ? 'openai' : '', context: store.state.settings.contextBudget,
    available: true, registered: true, certified: false, vision: false, hosted_web_search: false, hosted_image_generation: false };
}
export function xbotModels(store: Store, provider?: ProviderKind) {
  return providerKinds.filter(kind => !provider || kind === provider).flatMap(kind => {
    const models = new Set<string>();
    if (kind !== 'openai') models.add('default');
    if (kind === 'openai') {
      for (const model of (meta(store).settings.apiModels ?? []) as string[]) models.add(model);
      if (store.state.settings.defaultModel) models.add(store.state.settings.defaultModel);
    }
    for (const bot of store.state.bots) if (bot.provider === kind && bot.model) models.add(bot.model);
    for (const template of store.state.templates) if (template.defaultProvider === kind && template.defaultModel) models.add(template.defaultModel);
    return [...models].map(model => modelRow(store, kind, model));
  });
}
function secretFile(store: Store) { return join(dirname(store.file), 'provider-secrets.json'); }
function readSecrets(store: Store): Record<string, string> {
  if (!existsSync(secretFile(store))) return {};
  const value = JSON.parse(readFileSync(secretFile(store), 'utf8')) as unknown;
  return z.record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,99}$/), z.string()).parse(value);
}
function loadSecrets(store: Store): void {
  for (const [name, value] of Object.entries(readSecrets(store))) if (!process.env[name]) process.env[name] = value;
}
function saveKey(store: Store, key: string): void {
  const envName = store.state.settings.apiKeyEnv;
  const secrets = { ...readSecrets(store), [envName]: key };
  const file = secretFile(store); const temporary = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temporary, JSON.stringify(secrets), { mode: 0o600 }); renameSync(temporary, file);
  process.env[envName] = key;
}
const unsupported = (feature: string): never => { throw new ApiError(501, `${feature}尚未在 clowder-bot 中实现。`); };

/** Shapes match xbot's original models.go, binding.go and persona_cards.go. */
export function createXbotSettingsRouter(store: Store, orchestrator: Orchestrator, options: { fetcher?: typeof fetch } = {}) {
  const router = Router();
  meta(store); loadSecrets(store); store.save();
  const save = () => orchestrator.broadcast();
  const findBot = (name: string) => {
    const bot = store.state.bots.find(row => row.name === name || row.id === name);
    if (!bot) throw new ApiError(404, '找不到这个 Bot');
    return bot;
  };
  const ensureIdle = (bot: Bot) => {
    if (store.state.conversations.some(conversation => conversation.botIds.includes(bot.id) && orchestrator.busy(conversation.id))) throw new ApiError(409, 'Bot 正在工作，请结束后再修改');
  };
  const cards = (): Card[] => meta(store).personaCards;
  const picked = (bot: Bot, cardId: string) => personaCardSummary(store, bot)?.id === cardId;
  const cardBody = z.object({ name: z.string().trim().max(60).optional(), body: z.string().trim().min(1).max(32768) }).strict();
  const publicCard = (card: Card) => ({ ...card, bots: store.state.bots.filter(bot => picked(bot, card.id)).length });
  const createCard = (name: string | undefined, body: string) => {
    if (cards().length >= 200) throw new ApiError(400, '人设卡数量已达上限');
    const card: Card = { id: id('card'), name: name || body.split('\n').find(line => line.trim())?.replace(/^#+\s*/, '').slice(0, 60) || '新人设卡', body, updated: now() };
    cards().push(card); save(); return publicCard(card);
  };

  router.get('/models', (_req, res) => res.json({ models: xbotModels(store) }));
  router.get('/providers', (_req, res) => res.json({
    providers: providerKinds.map(kind => ({ name: kind, title: providerNames[kind], brand: kind === 'openai' ? 'openai' : '',
      protocol: kind === 'openai' ? 'chat_completions' : 'local', api_key_env: kind === 'openai' ? store.state.settings.apiKeyEnv : '',
      key_configured: kind !== 'openai' || !!process.env[store.state.settings.apiKeyEnv], models: xbotModels(store, kind),
      authentication: kind === 'demo' ? 'none' : kind === 'openai' ? 'api_key' : 'cli_local',
    })),
    vendors: [{ brand: 'openai', title: 'OpenAI 兼容 API', protocol: 'chat_completions', models: xbotModels(store, 'openai').map(row => row.model) }],
  }));
  async function loadApiModels(): Promise<ReturnType<typeof modelRow>[]> {
    const key = process.env[store.state.settings.apiKeyEnv];
    if (!key) throw new ApiError(422, '请先配置 API 密钥');
    const base = new URL(store.state.settings.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new ApiError(400, '模型服务地址无效');
    base.pathname = base.pathname.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '') + '/models';
    try {
      const response = await (options.fetcher ?? fetch)(base, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(12_000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      const data = await response.json() as { data?: unknown };
      if (!Array.isArray(data.data)) throw new Error('invalid catalog');
      const models = data.data.map(row => (row as { id?: unknown })?.id)
        .filter((name): name is string => typeof name === 'string' && name.length > 0 && name.length <= 200)
        .filter(name => !/embedding|whisper|tts|dall-e|image|audio|realtime|moderation/i.test(name)).slice(0, 1000);
      meta(store).settings.apiModels = [...new Set(models)];
      save(); return models.map(model => modelRow(store, 'openai', model));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(422, '模型名单读取失败，请检查服务地址、密钥和网络。');
    }
  }
  router.get('/providers/models', async (req, res) => {
    const kind = providerKind(String(req.query.provider ?? ''));
    res.json({ models: kind === 'openai' ? await loadApiModels() : xbotModels(store, kind) });
  });
  router.post('/providers/:brand/sync', async (req, res) => {
    if (req.params.brand !== 'openai') unsupported('此供应商的模型同步');
    res.json({ models: await loadApiModels() });
  });
  router.put('/providers/:brand/key', (req, res) => {
    if (req.params.brand !== 'openai') unsupported('此供应商的密钥接入');
    const input = z.object({ key: z.string().trim().min(8).max(512).regex(/^\S+$/, '密钥不能含空格或换行') }).strict().parse(req.body);
    if (store.state.conversations.some(conversation => orchestrator.busy(conversation.id))) throw new ApiError(409, '请等待当前回复结束再更换密钥');
    saveKey(store, input.key); res.json({ status: 'ok', provider: 'openai' });
  });
  router.put('/providers/models/image-generation', () => unsupported('模型图片生成'));
  router.all('/providers/oauth/{*path}', () => unsupported('供应商网页登录；请在本机 CLI 登录'));

  router.get('/persona-cards', (req, res) => {
    const query = String(req.query.q ?? '').trim().slice(0, 200).toLowerCase();
    res.json({ cards: cards().filter(card => `${card.name}\n${card.body}`.toLowerCase().includes(query)).map(card => ({
      id: card.id, name: card.name, preview: card.body.split('\n').find(line => line.trim())?.replace(/^#+\s*/, '').slice(0, 240) ?? '',
      search: card.body.slice(0, 1024), updated: card.updated, default: card.id === cards()[0]?.id,
    })) });
  });
  router.post('/persona-cards', (req, res) => { const input = cardBody.parse(req.body); res.json(createCard(input.name, input.body)); });
  router.post('/persona-cards/import', (req, res) => {
    const input = z.object({ filename: z.string().max(500), content: z.string().trim().min(1).max(32768), confirm: z.boolean().optional() }).strict().parse(req.body);
    const first = input.content.split('\n').map(line => line.trim().replace(/^#+\s*/, '')).find(line => line && line !== '---');
    let name = first && first.length <= 60 ? first : input.filename.split(/[\\/]/).at(-1)!.replace(/\.[^.]+$/, '').slice(0, 60) || '导入的人设卡';
    if (cards().some(card => card.name === name)) {
      if (!input.confirm) { res.status(409).json({ error: '库里已有同名人设卡', conflict: true, name }); return; }
      const original = name; for (let n = 2; cards().some(card => card.name === name); n++) name = `${original.slice(0, 52)} (${n})`;
    }
    res.json(createCard(name, input.content));
  });
  router.get('/persona-cards/:id', (req, res) => {
    const card = getPersonaCard(store, req.params.id); if (!card) throw new ApiError(404, '没有找到这张人设卡'); res.json(publicCard(card));
  });
  router.put('/persona-cards/:id', (req, res) => {
    const card = getPersonaCard(store, req.params.id); if (!card) throw new ApiError(404, '没有找到这张人设卡');
    const input = cardBody.partial().parse(req.body);
    const users = store.state.bots.filter(bot => picked(bot, card.id)); users.forEach(ensureIdle);
    // Capture the independent duty before replacing a previously equal seed body.
    users.forEach(bot => {
      const info = botMeta(store, bot);
      info.duty ??= bot.persona === card.body ? '' : bot.persona;
      if (info.duty === card.body) info.duty = '';
    });
    Object.assign(card, input, { updated: now() });
    if (!card.name) card.name = '新人设卡';
    users.forEach(bot => applyBotPersona(store, bot)); save(); res.json(publicCard(card));
  });
  router.delete('/persona-cards/:id', (req, res) => {
    const card = getPersonaCard(store, req.params.id); if (!card) throw new ApiError(404, '没有找到这张人设卡');
    if (card.id === cards()[0]?.id) throw new ApiError(400, '默认人设卡不能删除，可以修改');
    const users = store.state.bots.filter(bot => picked(bot, card.id));
    if (users.length && req.query.force !== '1' && req.query.force !== 'true') { res.status(409).json({ error: `${users.length} 个 Bot 还在用这张人设卡`, conflict: true, bots: users.length }); return; }
    users.forEach(ensureIdle);
    meta(store).personaCards = cards().filter(item => item.id !== card.id);
    users.forEach(bot => { botMeta(store, bot).personaCard = cards()[0]?.id ?? ''; applyBotPersona(store, bot); });
    save(); res.json({ deleted: true, unbound: users.length });
  });
  router.put('/bots/:name/persona-card', (req, res) => {
    const bot = findBot(req.params.name); ensureIdle(bot);
    const input = z.object({ id: z.string().max(100) }).strict().parse(req.body);
    const card = getPersonaCard(store, input.id || undefined); if (!card) throw new ApiError(404, '没有找到这张人设卡');
    botMeta(store, bot).personaCard = card.id; applyBotPersona(store, bot); save();
    res.json({ name: bot.name, persona_card: personaCardSummary(store, bot) });
  });

  router.get('/account/me', (_req, res) => res.json({ app: false, local: true, account: {
    id: 'local-owner', owner: true, unbound: false, email: 'local@clowder-bot', name: meta(store).settings.ownerName ?? '我',
    official: false, gateway: '本地模式', gateway_ok: false,
  } }));
  router.get('/account/devices', (_req, res) => res.json({ devices: [], local: true, supported: false, reason: '本地模式不使用账号或设备绑定' }));
  router.all('/account/{*path}', () => unsupported('账号登录与跨设备同步'));
  router.get('/devices', (_req, res) => res.json({ supported: false, reason: '跨设备功能暂未实现', devices: [], pairing: null, gateway_ok: false,
    self: { id: 'local', name: meta(store).settings.deviceName ?? hostname(), os: process.platform, gateway: '', bot_messaging: false } }));
  router.patch('/devices/self', (req, res) => {
    const input = z.object({ name: z.string().trim().min(1).max(80) }).strict().parse(req.body);
    meta(store).settings.deviceName = input.name; save(); res.json({ id: 'local', name: input.name });
  });
  router.all('/devices/{*path}', () => unsupported('跨设备功能'));
  router.get('/permissions', (_req, res) => res.json({ confirm: 'off', supported: false, reason: 'Agent 沿用本机 CLI 权限设置；当前不支持网页审批卡' }));
  router.put('/permissions', () => unsupported('网页工具审批；Agent 沿用本机 CLI 权限设置'));
  router.get('/machines', (_req, res) => res.json({ machines: [], supported: false, reason: 'Agent 沿用本机 CLI 权限设置' }));
  router.all('/machines/{*path}', () => unsupported('机器权限控制'));
  router.get('/push', (_req, res) => res.json({ public_key: '', subscribed: false, supported: false, reason: '后台推送暂未实现' }));
  router.all('/push/{*path}', () => unsupported('后台推送'));
  router.get('/update', (_req, res) => res.json({ state: 'disabled', current: '0.1.0', latest: '', supported: false, reason: '源码运行，请手动更新项目' }));
  router.all('/update/{*path}', () => unsupported('自动更新'));
  router.get('/web-search', (_req, res) => res.json({ enabled: false, mode: 'local', provider: '', providers: [], supported: false, reason: '独立网页搜索暂未实现' }));
  router.get('/image-gen', (_req, res) => res.json({ enabled: false, provider: '', providers: [], supported: false, reason: '图片生成暂未实现' }));
  router.get('/apps', (_req, res) => res.json({ apps: [], connected: 0, supported: false, reason: '应用连接暂未实现' }));
  router.get('/skills', (_req, res) => res.json({ skills: [], supported: false, reason: '技能库暂未实现' }));
  for (const path of ['/web-search', '/image-gen', '/apps', '/skills']) {
    router.all(path, () => unsupported('此扩展功能'));
    router.all(`${path}/{*tail}`, () => unsupported('此扩展功能'));
  }
  return router;
}
