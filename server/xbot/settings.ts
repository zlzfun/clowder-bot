import { Router } from 'express';
import { hostname } from 'node:os';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { BotBridge, encode } from '../native/bridge.js';
import { agentInventory, bindAgent, startSummary } from '../native/agents.js';
import { type CatTemplate, presentTemplate } from '../native/cat-templates.js';

export function createXbotSettingsRouter(bridge: BotBridge) {
  const router = Router(), { native, store } = bridge;
  const unsupported = (reason: string): never => { throw new ApiError(501, reason); };
  router.get('/agents', async (req, res) => res.json(await agentInventory(bridge, req.query.refresh === '1')));
  router.get('/start', async (req, res) => res.json(await startSummary(bridge, req.query.refresh === '1')));
  router.post('/agents/:id/models', async (req, res) => {
    const input = z.object({ model: z.string().max(512).optional(), refresh: z.boolean().optional() }).strict().parse(req.body ?? {});
    res.json(await native.request('/api/cats/runtime-models', { method: 'POST', body: { runtimeId: req.params.id, ...input } }));
  });
  router.get('/cat-templates', async (_req, res) => {
    const catalog = await native.request<{ templates: CatTemplate[]; breeds: unknown[] }>('/api/bot-cat-templates');
    res.json({ ...catalog, templates: catalog.templates.map(presentTemplate) });
  });
  router.get('/cat-templates/:id', async (req, res) => {
    const entry = await native.request<{ template: CatTemplate }>(`/api/bot-cat-templates/${encode(req.params.id)}`);
    res.json({ ...entry, template: presentTemplate(entry.template) });
  });
  router.post('/cat-templates', async (req, res) => res.status(201).json(await native.request('/api/bot-cat-templates', { method: 'POST', body: req.body })));
  router.put('/cat-templates/:id', async (req, res) => res.json(await native.request(`/api/bot-cat-templates/${encode(req.params.id)}`, { method: 'PUT', body: req.body })));
  router.delete('/cat-templates/:id', async (req, res) => res.json(await native.request(`/api/bot-cat-templates/${encode(req.params.id)}`, { method: 'DELETE', body: req.body })));
  router.put('/bots/:name/agent', async (req, res) => {
    const { runtimeId } = z.object({ runtimeId: z.string().min(1).max(100) }).strict().parse(req.body);
    res.json(await bindAgent(bridge, await bridge.cat(req.params.name), runtimeId));
  });
  const retired = () => { throw new ApiError(410, '模型商店已退出。请在「Agents」里选择。'); };
  for (const path of ['/models', '/providers', '/providers/{*path}', '/setup/key', '/bots/:name/binding']) router.all(path, retired);
  router.get('/persona-cards', async (req, res) => {
    const q = String(req.query.q ?? '').toLowerCase();
    res.json({ cards: (await bridge.templates()).templates.filter(t => `${t.name} ${t.roleDescription}`.toLowerCase().includes(q)).map(t => ({ id: t.id, name: t.name, preview: t.roleDescription, search: t.personality, default: false, readonly: true })) });
  });
  router.get('/persona-cards/:id', async (req, res) => {
    const t = (await bridge.templates()).templates.find(t => t.id === req.params.id);
    if (!t) throw new ApiError(404, '模板不存在');
    res.json({ id: t.id, name: t.name, body: [t.roleDescription, t.personality, t.teamStrengths].filter(Boolean).join('\n\n'), readonly: true });
  });
  router.put('/bots/:name/persona-card', async (req, res) => {
    const cat = await bridge.cat(req.params.name), { id } = z.object({ id: z.string() }).parse(req.body);
    const t = (await bridge.templates()).templates.find(t => t.id === id);
    if (!t) throw new ApiError(404, '上游模板不存在');
    await native.request(`/api/cats/${encode(cat.id)}`, { method: 'PATCH', body: { roleDescription: t.roleDescription, personality: t.personality, teamStrengths: t.teamStrengths, expectedRevision: cat.configurationRevision } });
    res.json({ name: cat.name, persona_card: { id: t.id, name: t.name, preview: t.roleDescription } });
  });
  router.all('/persona-cards', () => unsupported('模板保持原样；请在猫猫的职责里改它的角色。'));
  router.all('/persona-cards/{*path}', () => unsupported('模板保持原样；请在猫猫的职责里改它的角色。'));
  router.get('/account/me', (_req, res) => res.json({ app: false, local: true, account: { id: 'clowder-bot-owner', owner: true, unbound: false, email: 'local@clowder-bot', name: '我', official: false, gateway: '本地 Clowder AI', gateway_ok: false } }));
  router.get('/account/devices', (_req, res) => res.json({ devices: [], local: true, supported: false, reason: '当前为本机部署' }));
  router.all('/account/{*path}', () => unsupported('当前为本机部署，不支持 XBot 账号系统'));
  router.get('/devices', (_req, res) => res.json({ devices: [], pairing: null, gateway_ok: false, supported: false, reason: '当前为本机部署', self: { id: 'local', name: store.state.deviceName ?? hostname(), os: process.platform, gateway: '', bot_messaging: false } }));
  router.patch('/devices/self', (req, res) => { store.state.deviceName = z.object({ name: label() }).parse(req.body).name; store.save(); res.json({ id: 'local', name: store.state.deviceName }); });
  router.get('/permissions', (_req, res) => res.json({ confirm: 'native', supported: false, reason: '确认由 Clowder AI 处理：对话里能答的在对话里答，其余在运行面板查看。', management_url: '/runtime.html' }));
  router.get('/machines', (_req, res) => res.json({ machines: [], supported: false, reason: '由 Clowder AI 管理' }));
  router.get('/push', (_req, res) => res.json({ public_key: '', subscribed: false, supported: false }));
  router.get('/update', (_req, res) => res.json({ state: 'disabled', current: '0.2.0', latest: '', supported: false, reason: '上游版本按 upstream.lock.json 显式升级' }));
  for (const path of ['/web-search', '/image-gen', '/apps', '/skills']) {
    router.get(path, (_req, res) => res.json({ enabled: false, mode: 'native', apps: [], skills: [], connected: 0, supported: false, reason: '由 Clowder AI 和本机 Agent 管理。' }));
    router.all(path, () => unsupported('请在 Clowder AI 的配置里设置'));
    router.all(`${path}/{*tail}`, () => unsupported('请在 Clowder AI 的配置里设置'));
  }
  for (const path of ['/permissions', '/machines', '/push', '/update', '/devices']) {
    router.all(path, () => unsupported('这项设置在这里没有对应的功能，请使用运行面板'));
    router.all(`${path}/{*tail}`, () => unsupported('这项设置在这里没有对应的功能，请使用运行面板'));
  }
  return router;
}
function label() { return z.string().trim().min(1).max(80); }
