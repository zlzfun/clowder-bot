import { Router } from 'express';
import { z } from 'zod';
import type { BotBridge } from '../native/bridge.js';
import { BotSchedules } from '../native/schedules.js';

export function createXbotSchedulesRouter(bridge: BotBridge) {
  const router = Router(), schedules = new BotSchedules(bridge);
  router.get('/bots/:name/routines', async (req, res) => res.json(await schedules.list(await bridge.cat(req.params.name))));
  router.post('/bots/:name/routines', async (req, res) => {
    const cat = await bridge.cat(req.params.name);
    res.status(201).json(await schedules.create(cat, req.body));
  });
  router.patch('/bots/:name/routines/:id', async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    res.json(await schedules.setEnabled(await bridge.cat(req.params.name), req.params.id, enabled));
  });
  router.delete('/bots/:name/routines/:id', async (req, res) => res.json(await schedules.remove(await bridge.cat(req.params.name), req.params.id)));
  router.get('/bots/:name/routines/:id/runs', async (req, res) => res.json(await schedules.runs(await bridge.cat(req.params.name), req.params.id)));
  return router;
}
