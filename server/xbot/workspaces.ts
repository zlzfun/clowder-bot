import express, { type Request } from 'express';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { BotBridge, encode } from '../native/bridge.js';
import type { NativeCat, NativeThread } from '../native/types.js';
import { MAX_FILE_BYTES } from '../workspaces.js';

interface Task { id: string; threadId: string; kind: string; subjectKey: string | null; entrustedWork?: unknown; title: string; ownerCatId: string | null; ownerRevision?: number; status: string; [key:string]: unknown }
const expected = z.string().min(1).max(200);
const revision = z.number().int().nonnegative();
const area = z.enum(['workspace','shared']).default('workspace');

export function createWorkspaceRouter(bridge: BotBridge) {
  const router = express.Router(), ws = bridge.workspaces;
  router.get('/projects', (_req,res) => res.json({ projects: bridge.store.state.projects }));
  router.post('/projects', () => { throw new ApiError(410, '项目管理已收起，请直接在聊天中工作'); });
  for (const kind of ['bots','groups'] as const) {
    const base = `/${kind}/:chat`;
    const context = async (req:Request):Promise<{thread:NativeThread;cat?:NativeCat}> => {
      const id = String(req.params.chat);
      if (kind === 'groups') return {thread:await bridge.group(id)};
      const cat = await bridge.cat(id); return {cat,thread:await bridge.direct(cat)};
    };
    const checkThread = (thread:NativeThread,id:string) => { if (id !== thread.id) throw new ApiError(409,'会话已变化，请刷新后重试'); };
    const readTask = async (thread:NativeThread,id:string) => {
      const task = await bridge.native.request<Task>(`/api/tasks/${encode(id)}`);
      if (task.threadId !== thread.id) throw new ApiError(404,'这个任务不属于当前会话');
      if (task.kind !== 'work' || task.subjectKey !== null || task.entrustedWork) throw new ApiError(409,'此类任务请在原生运行面板处理');
      return task;
    };
    const member = async (thread:NativeThread,id:string|null) => {
      if (id === null) return;
      if (!thread.preferredCats?.includes(id) || !(await bridge.cats()).some(c=>c.id===id)) throw new ApiError(400,'负责人必须是当前会话的猫猫');
    };
    router.get(`${base}/workspace`,async(req,res)=>{const {thread,cat}=await context(req); res.json(await ws.view(thread,cat));});
    if (kind === 'bots') {
      router.put(`${base}/workspace`, () => { throw new ApiError(410, '项目切换已收起，旧会话可从历史对话打开'); });
      router.get(`${base}/conversations`,async(req,res)=>{ const {cat}=await context(req); res.json(await ws.conversations(cat!)); });
      router.put(`${base}/conversation`,async(req,res)=>{
        const body=z.object({threadId:expected,expectedThreadId:expected}).strict().parse(req.body);
        const {cat}=await context(req); res.json(await ws.switchConversation(cat!,body.threadId,body.expectedThreadId));
      });
    }
    router.get(`${base}/workspace-tree`,async(req,res)=>{
      const query=z.object({path:z.string().max(2000).default(''),area}).strict().parse(req.query);
      const {thread}=await context(req); res.json(await ws.tree(thread,query.path,query.area));
    });
    router.get(`${base}/files`,async(req,res)=>{
      const {thread}=await context(req);
      res.json({threadId:thread.id,files:Object.values(bridge.store.state.files).filter(f=>f.threadId===thread.id).sort((a,b)=>b.createdAt-a.createdAt).map(f=>ws.fileView(f))});
    });
    router.post(`${base}/files`,express.raw({type:'application/octet-stream',limit:MAX_FILE_BYTES}),async(req,res)=>{
      const query=z.object({name:z.string().min(1).max(180),expectedThreadId:expected}).strict().parse(req.query);
      if(!Buffer.isBuffer(req.body)) throw new ApiError(415,'文件上传需要 application/octet-stream');
      const {thread}=await context(req); checkThread(thread,query.expectedThreadId);
      const file=await ws.saveFile(thread,query.name,req.body,'attachment'); res.status(201).json({file});
    });
    router.post(`${base}/deliverables`,async(req,res)=>{
      const body=z.object({path:z.string().min(1).max(2000),area,expectedThreadId:expected,sourceMessageId:expected.optional()}).strict().parse(req.body);
      const {thread}=await context(req); checkThread(thread,body.expectedThreadId);
      res.status(201).json({file:await ws.deliver(thread,body.path,body.area,body.sourceMessageId)});
    });
    router.get(`${base}/tasks`,async(req,res)=>{
      const {thread}=await context(req);
      const [result,cats]=await Promise.all([bridge.native.request<{tasks:Task[];assignmentHistoryVersion?:number}>(`/api/tasks?threadId=${encode(thread.id)}`),bridge.cats()]);
      res.json({threadId:thread.id,tasks:result.tasks,cats:cats.filter(c=>thread.preferredCats?.includes(c.id)).map(c=>({id:c.id,name:c.name})),historyAvailable:result.assignmentHistoryVersion===1});
    });
    router.post(`${base}/tasks`,async(req,res)=>{
      const body=z.object({title:z.string().trim().min(1).max(200),why:z.string().max(1000).default(''),ownerCatId:z.string().nullable().optional(),expectedThreadId:expected}).strict().parse(req.body);
      const {thread}=await context(req); checkThread(thread,body.expectedThreadId); await member(thread,body.ownerCatId??null);
      const task=await bridge.native.request('/api/tasks',{method:'POST',body:{threadId:thread.id,title:body.title,why:body.why,ownerCatId:body.ownerCatId??null,createdBy:'user'}});
      res.status(201).json({task});
    });
    router.patch(`${base}/tasks/:id`,async(req,res)=>{
      const body=z.object({expectedOwnerRevision:revision,ownerCatId:z.string().nullable().optional(),status:z.enum(['todo','doing','blocked','done']).optional(),why:z.string().max(1000).optional()}).strict()
        .refine(v=>v.ownerCatId!==undefined||v.status!==undefined||v.why!==undefined,{message:'请选择需要更新的任务字段'}).parse(req.body);
      const {thread}=await context(req); await readTask(thread,String(req.params.id));
      if(body.ownerCatId!==undefined) await member(thread,body.ownerCatId);
      res.json({task:await bridge.native.request(`/api/tasks/${encode(String(req.params.id))}`,{method:'PATCH',body})});
    });
    router.post(`${base}/tasks/:id/handoff`,async(req,res)=>{
      const body=z.object({targetCatId:z.string().min(1),expectedOwnerRevision:revision,note:z.string().trim().max(2000).default(''),idempotencyKey:z.uuid()}).strict().parse(req.body);
      const {thread}=await context(req),task=await readTask(thread,String(req.params.id)); await member(thread,body.targetCatId);
      if(!task.ownerCatId||task.ownerCatId===body.targetCatId||task.status==='done') throw new ApiError(409,'当前任务不能请求交接给这个成员');
      await member(thread,task.ownerCatId);
      if((task.ownerRevision??0)!==body.expectedOwnerRevision) throw new ApiError(409,'负责人已变化，请刷新后重试');
      const receipt=await bridge.native.request('/api/messages',{method:'POST',body:{threadId:thread.id,mentions:[task.ownerCatId],messageDisposition:'continue_current',idempotencyKey:body.idempotencyKey,
        content:`请将原生 Task ${task.id}（当前 owner revision ${body.expectedOwnerRevision}）正式交接给 @${body.targetCatId}。只收束此任务所属执行，保留其他任务；使用原生 Task-backed 交接，回报实际结果。${body.note?'\n交接说明：'+body.note:''}`}});
      res.status(202).json({status:'requested',receipt});
    });
    router.post(`${base}/tasks/:id/control`,async(req,res)=>{
      const body=z.object({action:z.enum(['stop','cancel','resume']),expectedOwnerRevision:revision,expectedAttemptId:z.string().nullable()}).strict().parse(req.body);
      const {thread}=await context(req); await readTask(thread,String(req.params.id));
      res.json(await bridge.native.request(`/api/tasks/${encode(String(req.params.id))}/background-control`,{method:'POST',body}));
    });
  }
  for(const mode of ['download','preview','image']) router.get(`/files/:id/${mode}`,async(req,res)=>{
    const file=ws.file(String(req.params.id)),bytes=await ws.bytes(file);
    res.set({'Content-Security-Policy':"default-src 'none'; sandbox",'Cache-Control':'no-store'});
    if(mode==='preview') {
      if(file.mime!=='text/plain') throw new ApiError(415,'此文件只支持下载');
      return res.json({text:bytes.subarray(0,128*1024).toString('utf8'),truncated:bytes.length>128*1024});
    }
    if(mode==='image') {if(!['image/png','image/jpeg','image/gif','image/webp'].includes(file.mime))throw new ApiError(415,'此文件不支持图片预览');res.type(file.mime);}
    else {res.type('application/octet-stream');res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encode(file.name)}`);}
    res.send(bytes);
  });
  return router;
}
