import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import type { BotBridge } from '../native/bridge.js';

/** 这台电脑, per cat: what its 资料 shows and the switch. The words and the rules are in server/native/computer.ts. */
export function createComputerRouter(bridge: BotBridge) {
  const router = Router();
  router.get('/bots/:name/computer', async (req, res) => res.json(await bridge.computer.view(await bridge.cat(req.params.name))));
  // Answers with the view as it is afterwards. `on: false` after asking for it on means nothing was switched (see Computer.enable).
  router.put('/bots/:name/computer', async (req, res) => {
    const { enabled, confirmOff } = z.object({ enabled: z.boolean(), confirmOff: z.array(z.string()).max(200).optional() }).strict().parse(req.body);
    try {
      res.json(await bridge.computer.set(await bridge.cat(req.params.name), enabled, confirmOff));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === 'computer_confirm_changed' && error.details) {
        res.status(409).json({ error: error.message, code: error.code, details: error.details });
        return;
      }
      throw error;
    }
  });
  return router;
}
