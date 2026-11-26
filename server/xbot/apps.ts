import { Router } from 'express';
import type { BotBridge } from '../native/bridge.js';
import { BotApps, customPatchSchema, parseCustomApp } from '../native/apps.js';
import { ApiError } from '../errors.js';

/** 应用 (docs/apps-api.md). Every answer is the engine's state read back, not what was asked for. */
export function createXbotAppsRouter(bridge: BotBridge, apps = new BotApps(bridge.native, bridge.store)) {
  const router = Router();
  router.get('/apps', async (_req, res) => res.json(await apps.list()));
  router.post('/apps/custom', async (req, res) => res.status(201).json(await apps.addCustom(parseCustomApp(req.body))));
  router.post('/apps/wechat/connect', async (_req, res) => res.json(await apps.connectWechat()));
  router.post('/apps/wechat/disconnect', async (_req, res) => res.json(await apps.disconnectWechat()));
  router.post('/apps/wechat/authorize', async (_req, res) => res.json(await apps.authorizeWechat(true)));
  router.post('/apps/wechat/revoke', async (_req, res) => res.json(await apps.authorizeWechat(false)));
  router.get('/apps/:id', async (req, res) => res.json(await apps.detail(req.params.id)));
  router.patch('/apps/:id', async (req, res) => res.json(await apps.patchCustom(req.params.id, customPatchSchema.parse(req.body))));
  router.delete('/apps/:id', async (req, res) => {
    if (req.params.id === 'wechat') throw new ApiError(405, '微信不能移除，可以关掉', undefined, 'app_builtin');
    res.json(await apps.removeCustom(req.params.id));
  });
  return router;
}
