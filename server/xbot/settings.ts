import { Router } from 'express';
import { hostname } from 'node:os';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { BotBridge, encode } from '../native/bridge.js';
import { agentInventory, bindAgent } from '../native/agents.js';

export function createXbotSettingsRouter(bridge: BotBridge) {
  const router = Router(), { native, store } = bridge;
  const unsupported = (reason: string): never => { throw new ApiError(501, reason); };
  router.get('/agents', async (req, res) => res.json(await agentInventory(bridge, req.query.refresh === '1')));
  router.put('/bots/:name/agent', async (req, res) => {
    const { runtimeId } = z.object({ runtimeId: z.string().min(1).max(100) }).strict().parse(req.body);
    res.json(await bindAgent(bridge, await bridge.cat(req.params.name), runtimeId));
  });
  const retired = () => { throw new ApiError(410, '模型商店接口已退出。请在本地 Agent 接入中选择执行者。'); };
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
  router.all('/persona-cards', () => unsupported('上游模板保持原样；请在 Bot 职责中修改该成员的原生角色。'));
  router.all('/persona-cards/{*path}', () => unsupported('上游模板保持原样；请在 Bot 职责中修改该成员的原生角色。'));
  router.get('/account/me', (_req, res) => res.json({ app: false, local: true, account: { id: 'clowder-bot-owner', owner: true, unbound: false, email: 'local@clowder-bot', name: '我', official: false, gateway: '本地 Clowder AI', gateway_ok: false } }));
  router.get('/account/devices', (_req, res) => res.json({ devices: [], local: true, supported: false, reason: '当前为本机部署' }));
  router.all('/account/{*path}', () => unsupported('当前为本机部署，不支持 XBot 账号系统'));
  router.get('/devices', (_req, res) => res.json({ devices: [], pairing: null, gateway_ok: false, supported: false, reason: '当前为本机部署', self: { id: 'local', name: store.state.deviceName ?? hostname(), os: process.platform, gateway: '', bot_messaging: false } }));
  router.patch('/devices/self', (req, res) => { store.state.deviceName = z.object({ name: label() }).parse(req.body).name; store.save(); res.json({ id: 'local', name: store.state.deviceName }); });
  router.get('/permissions', (_req, res) => res.json({ confirm: 'native', supported: false, reason: '审批由 Clowder AI 执行。请在运行面板查看并处理原生审批。', management_url: '/runtime.html' }));
  router.get('/machines', (_req, res) => res.json({ machines: [], supported: false, reason: '由 Clowder AI 原生执行策略管理' }));
  router.get('/push', (_req, res) => res.json({ public_key: '', subscribed: false, supported: false }));
  router.get('/update', (_req, res) => res.json({ state: 'disabled', current: '0.2.0', latest: '', supported: false, reason: '上游版本按 upstream.lock.json 显式升级' }));
  for (const path of ['/web-search', '/image-gen', '/apps', '/skills']) {
    router.get(path, (_req, res) => res.json({ enabled: false, mode: 'native', apps: [], skills: [], connected: 0, supported: false, reason: '能力由 Clowder AI 与本地 Agent 管理。' }));
    router.all(path, () => unsupported('请使用 Clowder AI 原生配置'));
    router.all(`${path}/{*tail}`, () => unsupported('请使用 Clowder AI 原生配置'));
  }
  for (const path of ['/permissions', '/machines', '/push', '/update', '/devices']) {
    router.all(path, () => unsupported('此 XBot 设置没有原生等价项，请使用运行面板'));
    router.all(`${path}/{*tail}`, () => unsupported('此 XBot 设置没有原生等价项，请使用运行面板'));
  }
  return router;
}
function label() { return z.string().trim().min(1).max(80); }
