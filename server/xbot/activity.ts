import express from 'express';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import type { BotBridge } from '../native/bridge.js';
import { searchMessages } from '../native/search.js';
import { messageBlocks } from '../native/blocks.js';

export function createActivityRouter(bridge: BotBridge) {
  const router = express.Router();
  // Find a phrase in the owner's conversations (the newest page of each, read now).
  router.get('/search', async (req, res) => {
    const query = z.string().trim().min(1).max(100).parse(req.query.q);
    res.json(await searchMessages(bridge, query));
  });
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
    // What cats asked the owner to confirm here, and the owner's answer to one of them.
    router.get<{chat:string}>(`${scope}/approvals`, async (req,res) => {
      const {thread}=await context(String(req.params.chat));
      res.json({threadId:thread.id,approvals:await bridge.approvals.list(thread.id)});
    });
    router.post<{chat:string;id:string}>(`${scope}/approvals/:id`, async (req,res) => {
      const {decision,expectedThreadId}=z.object({decision:z.enum(['approve','reject']),expectedThreadId:z.string().min(1).max(200)}).strict().parse(req.body);
      const {thread}=await context(String(req.params.chat));
      if(thread.id!==expectedThreadId)throw new ApiError(409,'会话已变化，请刷新后重试');
      res.json(await bridge.approvals.decide(thread.id,String(req.params.id),decision));
    });
    // Record that the owner answered a cat's choice block. The answer itself is an ordinary chat message
    // sent through the normal route; this only tells native which options were picked, so the block stops asking.
    router.post<{chat:string;message:string;block:string}>(`${scope}/messages/:message/blocks/:block/answer`, async (req,res) => {
      const {selectedIds,expectedThreadId}=z.object({selectedIds:z.array(z.string().min(1).max(200)).max(40),expectedThreadId:z.string().min(1).max(200)}).strict().parse(req.body);
      const {thread}=await context(String(req.params.chat));
      if(thread.id!==expectedThreadId)throw new ApiError(409,'会话已变化，请刷新后重试');
      // The message has to be one of this conversation's and carry that choice.
      const message=(await bridge.allMessages(thread.id)).find(item=>item.id===String(req.params.message));
      const block=message&&messageBlocks(message).blocks.find(item=>item.id===String(req.params.block));
      if(!block||block.kind!=='choices')throw new ApiError(404,'这条消息里没有这个选项');
      if(selectedIds.some(id=>!block.options.some(option=>option.id===id)))throw new ApiError(400,'选项不在这条消息里');
      await bridge.native.request(`/api/messages/${encodeURIComponent(message!.id)}/block-state`,{method:'PATCH',body:{userId:'clowder-bot-owner',blockId:block.id,disabled:true,selectedIds}});
      res.json({messageId:message!.id,blockId:block.id,selected:selectedIds,answered:true});
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
