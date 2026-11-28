import express from 'express';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import type { BotBridge } from '../native/bridge.js';
import { searchMessages } from '../native/search.js';
import { allowedCallbackEndpoint, isAllowlistedCallbackAction, messageBlocks } from '../native/blocks.js';

const rec = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function createActivityRouter(bridge: BotBridge) {
  const router = express.Router();
  router.get('/media/:id', async (req, res) => {
    const media = await bridge.nativeFiles.readMedia(String(req.params.id));
    res.set({
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.type(media.mime);
    res.send(media.bytes);
  });
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
    // The same search inside one chat's current conversation.
    router.get<{chat:string}>(`${scope}/search`, async (req, res) => {
      const query = z.string().trim().min(1).max(100).parse(req.query.q);
      if (kind === 'groups') { const thread = await bridge.group(String(req.params.chat)); return void res.json(await searchMessages(bridge, query, 30, { chat: { type: 'group', id: thread.id, name: '' }, threadId: thread.id })); }
      const cat = await bridge.cat(String(req.params.chat)), thread = await bridge.direct(cat);
      res.json(await searchMessages(bridge, query, 30, { chat: { type: 'bot', id: cat.id, name: cat.name }, threadId: thread.id }));
    });
    router.get<{chat:string}>(`${scope}/activity`, async (req,res) => {
      const {thread, catId}=await context(String(req.params.chat));
      res.json(await bridge.activity.read(thread.id, undefined, undefined, catId));
    });
    // What cats asked the owner to confirm here, and the owner's answer to one of them.
    router.get<{chat:string}>(`${scope}/approvals`, async (req,res) => {
      const {thread}=await context(String(req.params.chat));
      const rawIds = typeof req.query.ids === 'string' ? req.query.ids.split(',').map(s => s.trim()).filter(Boolean) : [];
      const ids = z.array(z.string().min(1).max(200)).max(50).parse(rawIds);
      const view = await bridge.approvals.listView(thread.id, ids);
      res.json({threadId:thread.id,approvals:view.approvals,...(view.settled.length?{settled:view.settled}:{})});
    });
    router.post<{chat:string;id:string}>(`${scope}/approvals/:id`, async (req,res) => {
      const input=z.object({
        decision:z.enum(['approve','reject']).optional(),
        response:z.unknown().optional(),
        expectedRevision:z.number().int().positive().optional(),
        operationId:z.string().trim().min(1).max(200).optional(),
        expectedThreadId:z.string().min(1).max(200),
      }).strict().refine(v => v.decision !== undefined || v.response !== undefined, { message: '请提供确认决定或回答内容' }).parse(req.body);
      const {thread}=await context(String(req.params.chat));
      if(thread.id!==input.expectedThreadId)throw new ApiError(409,'对话已变化，请刷新后重试');
      res.json(await bridge.approvals.decide(thread.id,String(req.params.id),{
        ...(input.decision?{decision:input.decision}:{}),
        ...(input.response!==undefined?{response:input.response}:{}),
        ...(input.expectedRevision!==undefined?{expectedRevision:input.expectedRevision}:{}),
        ...(input.operationId?{operationId:input.operationId}:{}),
      }));
    });
    // Record that the owner answered a cat's choice block. The answer itself is an ordinary chat message
    // sent through the normal route; this only tells native which options were picked, so the block stops asking.
    router.post<{chat:string;message:string;block:string}>(`${scope}/messages/:message/blocks/:block/answer`, async (req,res) => {
      const {selectedIds,expectedThreadId}=z.object({selectedIds:z.array(z.string().min(1).max(200)).max(40),expectedThreadId:z.string().min(1).max(200)}).strict().parse(req.body);
      const {thread}=await context(String(req.params.chat));
      if(thread.id!==expectedThreadId)throw new ApiError(409,'对话已变化，请刷新后重试');
      // The message has to be one of this conversation's and carry that choice.
      const message=(await bridge.allMessages(thread.id)).find(item=>item.id===String(req.params.message));
      const block=message&&messageBlocks(message).blocks.find(item=>item.id===String(req.params.block));
      if(!block||block.kind!=='choices')throw new ApiError(404,'这条消息里没有这个选项');
      if(selectedIds.some(id=>!block.options.some(option=>option.id===id)))throw new ApiError(400,'选项不在这条消息里');
      if(selectedIds.some(id=>block.options.find(option=>option.id===id)?.action))throw new ApiError(400,'这个选项需要通过操作接口执行');
      // Native's block-state write takes whatever it is given and closes the block for good, so what a
      // choice allows is checked here: each option once, one answer for a single choice or a confirmation,
      // one to `max` for a multiple choice, and only while the block is still asking.
      if(block.answered)throw new ApiError(409,'这个选项已经回答过了',undefined,'already_answered');
      if(new Set(selectedIds).size!==selectedIds.length)throw new ApiError(400,'同一个选项不能选两次');
      if(!selectedIds.length)throw new ApiError(400,'至少选一项');
      if(block.mode!=='multiple'&&selectedIds.length!==1)throw new ApiError(400,'这里只能选一项');
      if(block.mode==='multiple'&&block.max&&selectedIds.length>block.max)throw new ApiError(400,`最多选 ${block.max} 项`);
      await bridge.native.request(`/api/messages/${encodeURIComponent(message!.id)}/block-state`,{method:'PATCH',body:{userId:'clowder-bot-owner',blockId:block.id,disabled:true,selectedIds}});
      res.json({messageId:message!.id,blockId:block.id,selected:selectedIds,answered:true});
    });
    // Execute an allowlisted F155 OptionAction callback from the authoritative native message record,
    // then persist block-state disabled/selectedIds so answered: true survives reload.
    router.post<{chat:string;message:string;block:string}>(`${scope}/messages/:message/blocks/:block/action`, async (req,res) => {
      const {optionId,customInput,expectedThreadId}=z.object({
        optionId:z.string().min(1).max(200),
        customInput:z.string().max(2000).optional(),
        expectedThreadId:z.string().min(1).max(200),
      }).strict().parse(req.body);
      const {thread}=await context(String(req.params.chat));
      if(thread.id!==expectedThreadId)throw new ApiError(409,'对话已变化，请刷新后重试',undefined,'thread_changed');
      const message=(await bridge.allMessages(thread.id)).find(item=>item.id===String(req.params.message));
      if(!message||message.isDraft||message.type!=='assistant')throw new ApiError(404,'这条消息里没有这个选项');
      const projected=messageBlocks(message).blocks.find(item=>item.id===String(req.params.block));
      if(!projected||projected.kind!=='choices')throw new ApiError(404,'这条消息里没有这个选项');
      if(projected.answered)throw new ApiError(409,'这个选项已经回答过了',undefined,'already_answered');
      const rawBlocks=Array.isArray(rec(message.extra?.rich).blocks)?(rec(message.extra?.rich).blocks as unknown[]).slice(0,50):[];
      const rawBlock=rawBlocks.map(rec).find(item=>item.id===projected.id&&item.kind==='interactive');
      const rawOptions=Array.isArray(rawBlock?.options)?rawBlock.options.map(rec):[];
      const chosen=rawOptions.find(option=>option.id===optionId);
      if(!chosen)throw new ApiError(400,'选项不在这条消息里');
      if(!isAllowlistedCallbackAction(chosen.action))throw new ApiError(400,'这个选项不支持直接操作');
      const endpoint=allowedCallbackEndpoint(chosen.action.endpoint);
      if(!endpoint)throw new ApiError(400,'这个选项不支持直接操作');
      const payload=rec(chosen.action.payload);
      let nativeBody:Record<string,unknown>={};
      if(endpoint==='/api/guide-actions/cancel'){
        if(payload.threadId!==thread.id||typeof payload.guideId!=='string'||!payload.guideId.trim()){
          throw new ApiError(400,'回调参数不完整');
        }
        nativeBody={threadId:thread.id,guideId:payload.guideId.trim()};
      }else if(endpoint==='/api/auto-dream/life-settings/decision'){
        if(typeof payload.previewId!=='string'||!payload.previewId.trim()||(payload.decision!=='confirm'&&payload.decision!=='cancel')){
          throw new ApiError(400,'回调参数不完整');
        }
        nativeBody={previewId:payload.previewId.trim(),decision:payload.decision};
      }else if(endpoint.endsWith('/confirm')){
        const desc=customInput?.trim();
        nativeBody=desc?{userDescription:desc}:{};
      }
      const nativeResult=await bridge.native.request(endpoint,{method:'POST',body:nativeBody});
      try{
        await bridge.native.request(`/api/messages/${encodeURIComponent(message.id)}/block-state`,{
          method:'PATCH',
          body:{userId:'clowder-bot-owner',blockId:projected.id,disabled:true,selectedIds:[optionId]},
        });
      }catch(error){
        res.status(502).json({
          error:'操作已执行，但没能记下选择状态，请刷新后查看',
          code:'callback_applied_state_failed',
          callbackApplied:true,
          answered:false,
          ...(error instanceof ApiError && error.details ? {native:error.details} : {}),
        });
        return;
      }
      res.json({messageId:message.id,blockId:projected.id,selected:[optionId],answered:true,native:nativeResult});
    });
    router.post<{chat:string}>(`${scope}/read`, async (req,res) => {
      const {expectedThreadId,messageId}=z.object({expectedThreadId:z.string().min(1).max(200),messageId:z.string().min(1).max(200)}).strict().parse(req.body);
      const {thread,catId}=await context(String(req.params.chat));
      if(thread.id!==expectedThreadId)throw new ApiError(409,'对话已变化，请刷新后重试');
      res.json(await bridge.activity.acknowledge(thread.id,messageId,()=>catId
        ? bridge.store.bot(catId).activeThreadId===thread.id : bridge.store.state.groupThreadIds.includes(thread.id)));
    });
  }
  return router;
}
