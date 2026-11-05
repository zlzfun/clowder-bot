import express from 'express';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import type { BotBridge } from '../native/bridge.js';

export function createActivityRouter(bridge: BotBridge) {
  const router = express.Router();
  for (const kind of ['bots', 'groups'] as const) {
    const scope = `/${kind}/:chat`;
    const context = async (name: string) => {
      if (kind === 'groups') return {thread:await bridge.group(name),catId:undefined};
      const cat = await bridge.cat(name); return {thread:await bridge.direct(cat),catId:cat.id};
    };
    router.get<{chat:string}>(`${scope}/activity`, async (req,res) => {
      const {thread}=await context(String(req.params.chat));
      res.json(await bridge.activity.read(thread.id));
    });
    router.post<{chat:string}>(`${scope}/read`, async (req,res) => {
      const {expectedThreadId,messageId}=z.object({expectedThreadId:z.string().min(1).max(200),messageId:z.string().min(1).max(200)}).strict().parse(req.body);
      const {thread,catId}=await context(String(req.params.chat));
      if(thread.id!==expectedThreadId)throw new ApiError(409,'会话已变化，请刷新后重试');
      res.json(await bridge.activity.acknowledge(thread.id,messageId,()=>catId
        ? bridge.store.bot(catId).activeThreadId===thread.id : bridge.store.state.groupThreadIds.includes(thread.id)));
    });
  }
  return router;
}
