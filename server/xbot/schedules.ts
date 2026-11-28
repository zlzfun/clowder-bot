import { Router } from 'express';
import { z } from 'zod';
import type { BotBridge } from '../native/bridge.js';
import { BotSchedules, schedulePromptSchema } from '../native/schedules.js';

const routinePatchSchema = z.union([
  z.object({ enabled: z.boolean() }).strict(),
  z.object({ prompt: schedulePromptSchema }).strict(),
]);

export function createXbotSchedulesRouter(bridge: BotBridge) {
  const router = Router(), schedules = new BotSchedules(bridge);
  router.get('/bots/:name/routines', async (req, res) => res.json(await schedules.list(await bridge.cat(req.params.name))));
  router.post('/bots/:name/routines', async (req, res) => {
    const cat = await bridge.cat(req.params.name);
    res.status(201).json(await schedules.create(cat, req.body));
  });
  router.patch('/bots/:name/routines/:id', async (req, res) => {
    const patch = routinePatchSchema.parse(req.body);
    const cat = await bridge.cat(req.params.name);
    res.json('enabled' in patch
      ? await schedules.setEnabled(cat, req.params.id, patch.enabled)
      : await schedules.updatePrompt(cat, req.params.id, patch.prompt));
  });
  router.delete('/bots/:name/routines/:id', async (req, res) => res.json(await schedules.remove(await bridge.cat(req.params.name), req.params.id)));
  router.get('/bots/:name/routines/:id/runs', async (req, res) => res.json(await schedules.runs(await bridge.cat(req.params.name), req.params.id)));
  return router;
}
