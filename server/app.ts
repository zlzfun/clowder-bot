import express, { type ErrorRequestHandler } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { ApiError } from './errors.js';
import { ProductStore } from './product-store.js';
import { NativeClient } from './native/client.js';
import { BotBridge } from './native/bridge.js';
import type { NativeTransport } from './native/types.js';
import { createXbotCoreRouter } from './xbot/core.js';
import { createXbotSettingsRouter } from './xbot/settings.js';

export function createApp(options: { dataFile?: string; native?: NativeTransport; staticDir?: string; workspace?: string; allowedOrigins?: string[] } = {}) {
  const port = Number(process.env.PORT || 3210);
  const origins = new Set(options.allowedOrigins ?? [`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5173', 'http://localhost:5173']);
  const native = options.native ?? new NativeClient(`http://127.0.0.1:${process.env.BOT_NATIVE_PORT || 4331}`, `http://127.0.0.1:${port}`);
  const store = new ProductStore(options.dataFile ?? process.env.BOT_PRODUCT_DATA_FILE);
  const bridge = new BotBridge(native, store, options.workspace ?? resolve(process.env.BOT_RUNTIME_DATA_DIR || 'data/native', 'workspace'));
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(req.hostname)) return res.status(403).json({ error: '只允许本机访问' });
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && !origins.has(req.headers.origin))) return res.status(403).json({ error: '拒绝未授权来源访问本地服务' });
    if (!/^\/(?:xbot-api|api|native-api)(?:\/|$)/.test(req.path)) return next();
    const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || !!req.headers['transfer-encoding'];
    const avatar = req.method === 'POST' && /^\/xbot-api\/bots\/[^/]+\/avatar$/.test(req.path) && req.is('multipart/form-data');
    if (hasBody && !req.is('application/json') && !avatar) return res.status(415).json({ error: '请求必须为 application/json' });
    res.setHeader('Cache-Control', 'no-store'); next();
  });
  app.use(express.json({ limit: '4mb' }));
  const core = createXbotCoreRouter(bridge);
  app.use('/xbot-api', core.router, createXbotSettingsRouter(bridge));
  app.use('/xbot-api', (_req, res) => res.status(404).json({ error: '此 XBot 接口尚无原生适配；请使用运行面板' }));
  app.get('/api/health', async (_req, res) => res.json({ ok: true, engine: 'clowder-ai', upstream: await native.request('/api/health') }));
  app.get('/api/state', async (_req, res) => res.json({ engine: 'clowder-ai', cats: await bridge.cats(), presentation: store.state }));
  // A small, explicit owner API surface for native concepts that XBot cannot represent.
  const ownerPaths = /^\/api\/(?:tasks(?:\/[^/]+(?:\/background-control)?)?|cats(?:\/[^/]+)?|cats\/native-runtimes|cat-templates|threads(?:\/[^/]+(?:\/(?:queue(?:\/[^/]+)?|sessions(?:\/[^/]+\/compact-native)?|task-progress|cancel\/[^/]+))?)?|messages|accounts(?:\/[^/]+)?|memory(?:\/(?:catalog|recall|recall\/stats|search|search\/document|library-feed|maintenance))?|evidence\/(?:status|search)|approval-hub\/(?:pending|settled)|runtime-interactions\/[^/]+(?:\/(?:respond|reject))?|(?:proposals|session-handoff|dispatch-proposals|taste-proposals|profile-updates|person-memory-proposals|entity-proposals|event-memory-corrections|schedule-proposals|eval-repair-proposals|dossier\/distillations)\/[^/]+\/(?:approve|reject)|config\/(?:capabilities|session-strategy))$/;
  app.use('/native-api', async (req, res) => {
    const path = req.url;
    if (!ownerPaths.test(path.split('?')[0]!) || !['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) throw new ApiError(404, '此原生接口未开放到 Bot 适配层');
    res.json(await native.request(path, { method: req.method, ...(req.body !== undefined ? { body: req.body } : {}) }));
  });
  app.use('/api', (_req, res) => res.status(410).json({ error: '旧自研引擎 API 已退出。请使用 /xbot-api 或 /native-api/api。' }));
  const staticDir = options.staticDir ?? resolve(process.env.BOT_STATIC_DIR || 'dist/client');
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get('/{*splat}', (_req, res) => res.sendFile(resolve(staticDir, 'index.html')));
  }
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) { res.end(); return; }
    if (error instanceof ZodError) { res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；') }); return; }
    if (error instanceof ApiError) { res.status(error.status).json({ error: error.message, ...(error.details ? { native: error.details } : {}) }); return; }
    if (error?.type === 'entity.too.large') { res.status(413).json({ error: '请求内容过大' }); return; }
    if (error instanceof SyntaxError && 'body' in error) { res.status(400).json({ error: 'JSON 格式不正确' }); return; }
    console.error('[clowder-bot]', error instanceof Error ? error.message : 'Unexpected error');
    res.status(500).json({ error: '服务出现异常，请查看日志。' });
  };
  app.use(errors);
  return { app, bridge, store, close: async () => { core.close(); await native.close(); } };
}
