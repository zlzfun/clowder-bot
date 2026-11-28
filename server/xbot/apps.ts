import { Router, type Response } from 'express';
import type { BotBridge } from '../native/bridge.js';
import { BotApps, customEnabledSchema, customPatchSchema, parseCustomApp } from '../native/apps.js';
import { ApiError } from '../errors.js';

const sse = (res: Response, event: string, data: unknown) => {
  if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

/** 应用 (docs/apps-api.md). Every answer is the engine's state read back, not what was asked for. */
export function createXbotAppsRouter(bridge: BotBridge, apps = new BotApps(bridge.native, bridge.store)) {
  const router = Router();
  const streams = new Set<() => void>();
  let closed = false;
  router.get('/apps', async (_req, res) => res.json(await apps.list()));
  router.get('/apps/events', async (_req, res) => {
    if (closed) { res.status(503).end(); return; }
    let ready = false;
    let clientClosed = false;
    const onEarlyClose = () => { clientClosed = true; };
    res.on('close', onEarlyClose);
    let endStream: () => void = () => {};
    let release: (() => void) | undefined;
    try {
      release = await apps.subscribeWechatEvents(event => {
        if (!ready || closed || res.destroyed || res.writableEnded) return;
        if (res.writableLength > 1_000_000) { endStream(); return; }
        sse(res, 'wechat', event);
      });
    } catch (error) {
      res.off('close', onEarlyClose);
      throw error;
    }
    res.off('close', onEarlyClose);
    if (clientClosed || closed || res.destroyed || res.writableEnded) {
      release();
      if (!res.writableEnded && !res.destroyed) res.end();
      return;
    }
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    ready = true;
    const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n'); }, 20_000);
    heartbeat.unref();
    endStream = () => {
      if (!streams.has(endStream)) return;
      streams.delete(endStream);
      clearInterval(heartbeat);
      release?.();
      if (!res.writableEnded && !res.destroyed) res.end();
    };
    streams.add(endStream);
    res.on('close', endStream);
    sse(res, 'ready', { appId: 'wechat' });
  });
  router.post('/apps/custom', async (req, res) => res.status(201).json(await apps.addCustom(parseCustomApp(req.body))));
  router.post('/apps/wechat/connect', async (_req, res) => res.json(await apps.connectWechat()));
  router.post('/apps/wechat/disconnect', async (_req, res) => res.json(await apps.disconnectWechat()));
  router.post('/apps/wechat/authorize', async (_req, res) => res.json(await apps.authorizeWechat(true)));
  router.post('/apps/wechat/revoke', async (_req, res) => res.json(await apps.authorizeWechat(false)));
  // 微信's picture: the icon of the program installed on this computer. Its address carries a mark that changes with the file, so it may be kept.
  router.get('/apps/wechat/icon', async (_req, res) => {
    const png = await apps.wechatIcon();
    if (!png) throw new ApiError(404, '没有这张图');
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400' }).send(png);
  });
  router.get('/apps/:id', async (req, res) => res.json(await apps.detail(req.params.id)));
  router.patch('/apps/:id', async (req, res) => res.json(await apps.patchCustom(req.params.id, customPatchSchema.parse(req.body))));
  router.put('/apps/:id/enabled', async (req, res) => res.json(await apps.setCustomEnabled(req.params.id, customEnabledSchema.parse(req.body).enabled)));
  router.put('/apps/:id/cats/:name', async (req, res) => res.json(await apps.setCustomCatEnabled(req.params.id, req.params.name, customEnabledSchema.parse(req.body).enabled)));
  router.delete('/apps/:id', async (req, res) => {
    if (req.params.id === 'wechat') throw new ApiError(405, '微信不能移除，可以关掉', undefined, 'app_builtin');
    res.json(await apps.removeCustom(req.params.id));
  });
  const close = () => {
    closed = true;
    for (const end of [...streams]) end();
    streams.clear();
  };
  return Object.assign(router, { close });
}
