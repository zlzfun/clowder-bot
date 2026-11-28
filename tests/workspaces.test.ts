import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { NativeFixture } from './native-fixture.js';
import { ApiError } from '../server/errors.js';
import { ProductStore } from '../server/product-store.js';

class WorkspaceNative extends NativeFixture {
  tasks = new Map<string,any>();
  override async request<T>(path:string,options:{method?:string;body?:any}={}):Promise<T> {
    const url=new URL(path,'http://fixture'),method=options.method??'GET',body=options.body;
    if(path==='/api/projects/mkdir') {
      const target=join(body.parentPath,body.name);
      try {await mkdir(target);} catch(e:any) {if(e.code==='EEXIST')throw new ApiError(409,'exists');throw e;}
      return {createdPath:target,name:body.name} as T;
    }
    if(url.pathname==='/api/tasks'&&method==='POST') {const task={...body,id:randomUUID(),kind:'work',subjectKey:null,status:'todo',ownerRevision:0,assignmentHistory:[]};this.tasks.set(task.id,task);return structuredClone(task);}
    if(url.pathname==='/api/tasks')return {tasks:[...this.tasks.values()].filter(t=>t.threadId===url.searchParams.get('threadId')),assignmentHistoryVersion:1} as T;
    if(url.pathname.startsWith('/api/tasks/')){
      const id=url.pathname.split('/')[3]!, task=this.tasks.get(id); if(!task)throw new ApiError(404,'missing');
      if(method==='PATCH') {if(body.expectedOwnerRevision!==task.ownerRevision)throw new ApiError(409,'Task assignment changed');if(task.executionRef&&body.ownerCatId!==undefined)throw new ApiError(409,'TASK_EXECUTION_MUST_STOP');Object.assign(task,body);}
      return structuredClone(task);
    }
    return super.request<T>(path,options);
  }
}
async function setup(t:any){
  const dir=await realpath(await mkdtemp(join(tmpdir(),'bot-workspaces-'))),workspace=join(dir,'workspace');await mkdir(workspace);
  const native=new WorkspaceNative(),runtime=createApp({native,workspace,dataFile:join(dir,'presentation.json')});
  const server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address();assert.ok(addr&&typeof addr!=='string');
  const base=`http://127.0.0.1:${addr.port}`;
  t.after(async()=>{await runtime.close();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});});
  const call=(path:string,method='GET',body?:unknown)=>fetch(base+'/xbot-api'+path,{method,headers:body!==undefined?{'Content-Type':'application/json'}:{},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const cat=await runtime.bridge.createBot({name:'Ada'}),bob=await runtime.bridge.createBot({name:'Bob'}),thread=await runtime.bridge.direct(cat);
  const upload=async(name:string,bytes:Buffer,threadId=thread.id)=>fetch(`${base}/xbot-api/bots/Ada/files?${new URLSearchParams({name,expectedThreadId:threadId})}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:new Uint8Array(bytes)});
  return {...runtime,native,dir,workspace,base,call,cat,bob,thread,upload};
}
async function legacyProject(r:Awaited<ReturnType<typeof setup>>) {
  const project={id:'project-'+randomUUID(),name:'Old research',path:join(r.workspace,'projects','old'),sharedPath:join(r.workspace,'projects','old','shared'),createdAt:10};
  const path=join(project.path,'cats',r.cat.id);await mkdir(path,{recursive:true});await mkdir(project.sharedPath,{recursive:true});
  r.store.state.projects.push(project);
  const thread=await r.bridge.newThread(r.cat.name,[r.cat.id],undefined,path);
  Object.assign(r.store.bot(r.cat.id),{workspaceThreads:{personal:r.thread.id,[project.id]:thread.id},projectId:project.id,activeThreadId:thread.id});r.store.save();
  return {project,thread};
}
test('project management is retired; default native directories need no project setup',async t=>{
  const r=await setup(t);
  assert.equal((await r.call('/projects','POST',{name:'Research',idempotencyKey:randomUUID()})).status,410);
  assert.equal((await r.call('/bots/Ada/workspace','PUT',{projectId:null,expectedThreadId:r.thread.id})).status,410);
  const view=await (await r.call('/bots/Ada/workspace')).json();
  assert.equal(view.defaultRoot,r.workspace);assert.equal(view.workspacePath,join(r.workspace,'cats',r.cat.id));assert.equal(view.canSwitch,false);
  assert.equal(view.project,undefined);assert.equal(view.sharedPath,view.workspacePath);
  const other=await r.bridge.direct(r.bob);assert.notEqual(other.projectPath,r.thread.projectPath);
});
test('legacy project conversations remain accessible with original files, messages and no migration',async t=>{
  const r=await setup(t),{project,thread}=await legacyProject(r);
  await writeFile(join(thread.projectPath as string,'report.md'),'legacy result');
  r.native.messages.set(thread.id,[{id:'old-msg',type:'assistant',catId:r.cat.id,content:'Old result',timestamp:5}]);
  const history=await (await r.call('/bots/Ada/conversations')).json();
  assert.equal(history.conversations.length,2);assert.equal(history.conversations.find((c:any)=>c.id===thread.id).title,project.name);
  const back=await r.call('/bots/Ada/conversation','PUT',{threadId:r.thread.id,expectedThreadId:thread.id});assert.equal(back.status,200);
  const again=await r.call('/bots/Ada/conversation','PUT',{threadId:thread.id,expectedThreadId:r.thread.id});assert.equal(again.status,200);
  assert.equal((await again.json()).workspacePath,thread.projectPath);
  const transcript=await (await r.call('/bots/Ada/transcript')).json();assert.equal(transcript.messages[0].native.content,'Old result');
  assert.equal(await readFile(join(thread.projectPath as string,'report.md'),'utf8'),'legacy result');
  assert.equal(new ProductStore(join(r.dir,'presentation.json')).bot(r.cat.id).activeThreadId,thread.id);
  assert.equal(r.store.state.projects.length,1);
});
test('conversation switching rejects busy, stale and foreign targets and preserves original selection',async t=>{
  const r=await setup(t),{thread}=await legacyProject(r),scope='/bots/Ada/conversation';
  r.native.queues.set(thread.id,{queue:[],activeInvocations:[{catId:r.cat.id}]});
  assert.equal((await r.call(scope,'PUT',{threadId:r.thread.id,expectedThreadId:thread.id})).status,409);
  r.native.queues.clear();r.native.queues.set(r.thread.id,{queue:[{id:'queued'}],activeInvocations:[]});
  assert.equal((await r.call(scope,'PUT',{threadId:r.thread.id,expectedThreadId:thread.id})).status,409);
  r.native.queues.clear();
  assert.equal((await r.call(scope,'PUT',{threadId:r.thread.id,expectedThreadId:'stale'})).status,409);
  const other=await r.bridge.direct(r.bob);
  assert.equal((await r.call(scope,'PUT',{threadId:other.id,expectedThreadId:thread.id})).status,404);
  r.store.bot(r.cat.id).conversationIds=[other.id];
  assert.equal((await r.call(scope,'PUT',{threadId:other.id,expectedThreadId:thread.id})).status,403);
  assert.equal(r.store.bot(r.cat.id).activeThreadId,thread.id);
});
test('new chats use default cat directory and retain all earlier conversation references',async t=>{
  const r=await setup(t),{thread}=await legacyProject(r);
  const response=await r.call('/bots/Ada/new','POST',{});assert.equal(response.status,200);const next=(await response.json()).conversation_id;
  assert.equal(r.native.threads.get(next)?.projectPath,r.thread.projectPath);
  const history=await (await r.call('/bots/Ada/conversations')).json();assert.equal(history.conversations.length,3);
  assert.ok(history.conversations.some((c:any)=>c.id===thread.id));assert.ok(history.conversations.find((c:any)=>c.id===next).current);
  // A page that still shows an earlier conversation must not start a new one; the current one may.
  const stale=await r.call('/bots/Ada/new','POST',{expectedThreadId:thread.id});assert.equal(stale.status,409);
  assert.equal((await (await r.call('/bots/Ada/conversations')).json()).conversations.length,3,'nothing was created');
  assert.equal((await r.call('/bots/Ada/new','POST',{expectedThreadId:next})).status,200);
  assert.equal((await r.call('/bots/Ada/new','POST',{other:1})).status,400);
});
test('new groups automatically get separate directories; legacy project group files remain readable',async t=>{
  const r=await setup(t),{project}=await legacyProject(r);
  assert.equal((await r.call('/groups','POST',{name:'Old',members:['Ada','Bob'],projectId:project.id})).status,410);
  const a=await (await r.call('/groups','POST',{name:'Team A',members:['Ada','Bob']})).json();
  const b=await (await r.call('/groups','POST',{name:'Team B',members:['Ada','Bob']})).json();
  const work=await (await r.call(`/groups/${a.id}/workspace`)).json();
  assert.ok(work.workspacePath.startsWith(join(r.workspace,'groups')+'/'));assert.notEqual(work.workspacePath,r.native.threads.get(b.id)?.projectPath);
  const old=await r.bridge.newThread('Legacy group',[r.cat.id,r.bob.id],undefined,project.sharedPath);r.store.state.groupThreadIds.push(old.id);r.store.state.groupProjects[old.id]=project.id;r.store.save();
  await writeFile(join(project.sharedPath,'old.txt'),'keep');
  const oldTree=await (await r.call(`/groups/${old.id}/workspace-tree`)).json();assert.ok(oldTree.entries.some((e:any)=>e.name==='old.txt'));
});
test('attachments persist bytes and checksum and are sent as native versioned content blocks',async t=>{
  const r=await setup(t),bytes=Buffer.from('source material'),response=await r.upload('research.md',bytes);assert.equal(response.status,201);const {file}=await response.json();
  assert.equal(file.name,'research.md');assert.match(file.sha256,/^[a-f0-9]{64}$/);
  const sent=await r.call('/bots/Ada/messages','POST',{text:'',attachments:[file.id],expectedThreadId:r.thread.id,idempotencyKey:randomUUID()});assert.equal(sent.status,200);await sent.text();
  const payload=r.native.calls.findLast(c=>c.path==='/api/messages')!.body;
  assert.deepEqual(payload.contextAttachments,[{v:1,id:file.id,kind:'workspace_file',path:file.path,revision:`sha256:${file.sha256}`}]);
  r.native.messages.set(r.thread.id,[{id:'file-msg',type:'user',catId:null,content:'',timestamp:1,contentBlocks:payload.contextAttachments.map((attachment:any)=>({type:'context_attachment',attachment}))}]);
  const transcript=await (await r.call('/bots/Ada/transcript')).json();assert.equal(transcript.messages[0].attachments[0].id,file.id);
  const downloaded=await fetch(r.base+file.url);assert.equal(downloaded.status,200);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes);
  assert.equal(new ProductStore(join(r.dir,'presentation.json')).state.files[file.id]!.sha256,file.sha256);
});
test('attachment identity is scoped, duplicate names cannot overwrite, and modified content is rejected',async t=>{
  const r=await setup(t);const {file:a}=await (await r.upload('same.txt',Buffer.from('a'))).json(),{file:b}=await (await r.upload('same.txt',Buffer.from('b'))).json();
  assert.notEqual(a.path,b.path);assert.equal(await readFile(a.path,'utf8'),'a');
  assert.equal((await r.call('/bots/Bob/messages','POST',{text:'x',attachments:[a.id],expectedThreadId:(await r.bridge.direct(r.bob)).id})).status,409);
  assert.equal((await r.upload('stale.txt',Buffer.from('x'),'other-thread')).status,409);
  assert.equal((await r.upload('../escape',Buffer.from('x'))).status,400);
  await writeFile(a.path,'changed');assert.equal((await fetch(r.base+a.url)).status,409);
});
test('deliverables snapshot real files; traversal, hidden files, symlinks and fake provenance fail',async t=>{
  const r=await setup(t),root=r.thread.projectPath as string;await writeFile(join(root,'report.md'),'finished');await writeFile(join(r.dir,'outside.txt'),'private');await symlink(join(r.dir,'outside.txt'),join(root,'escape.txt'));
  const response=await r.call('/bots/Ada/deliverables','POST',{path:'report.md',area:'workspace',expectedThreadId:r.thread.id});assert.equal(response.status,201);const {file}=await response.json();
  assert.equal(file.kind,'deliverable');await writeFile(join(root,'report.md'),'new draft');assert.equal(await (await fetch(r.base+file.url)).text(),'finished');
  for(const path of ['../outside.txt','escape.txt','.env','/etc/passwd'])assert.ok([403,404].includes((await r.call('/bots/Ada/deliverables','POST',{path,expectedThreadId:r.thread.id})).status));
  assert.equal((await r.call('/bots/Ada/deliverables','POST',{path:'report.md',expectedThreadId:r.thread.id,sourceMessageId:'invented'})).status,400);
  const tree=await (await r.call('/bots/Ada/workspace-tree')).json();assert.ok(tree.entries.some((e:any)=>e.name==='report.md'));assert.ok(!tree.entries.some((e:any)=>e.name==='escape.txt'||e.name.startsWith('.')));
});
test('active content downloads without execution, text previews are bounded, and fake image MIME is ignored',async t=>{
  const r=await setup(t),{file}=await (await r.upload('report.html',Buffer.from('<script>alert(1)</script>'))).json();
  const download=await fetch(r.base+file.url);assert.equal(download.headers.get('content-type'),'application/octet-stream');assert.match(download.headers.get('content-disposition')!,/^attachment/);assert.match(download.headers.get('content-security-policy')!,/sandbox/);
  assert.equal((await fetch(r.base+`/xbot-api/files/${file.id}/image`)).status,415);
  const {file:long}=await (await r.upload('long.txt',Buffer.alloc(140000,65))).json();const preview=await (await fetch(r.base+`/xbot-api/files/${long.id}/preview`)).json();assert.equal(preview.text.length,128*1024);assert.equal(preview.truncated,true);
});
test('chat tasks use native owners, reject outsiders/stale revisions, and request handoff without inventing success',async t=>{
  const r=await setup(t),group=await (await r.call('/groups','POST',{name:'Team',members:['Ada','Bob']})).json(),scope=`/groups/${group.id}`;
  const created=await r.call(scope+'/tasks','POST',{title:'Write report',ownerCatId:r.cat.id,expectedThreadId:group.id});assert.equal(created.status,201);const {task}=await created.json();
  const list=await (await r.call(scope+'/tasks')).json();assert.equal(list.historyAvailable,true);assert.equal(list.tasks[0].ownerCatId,r.cat.id);
  assert.equal((await r.call(scope+`/tasks/${task.id}`,'PATCH',{ownerCatId:'outsider',expectedOwnerRevision:0})).status,400);
  assert.equal((await r.call(scope+`/tasks/${task.id}`,'PATCH',{ownerCatId:r.bob.id,expectedOwnerRevision:5})).status,409);
  const requested=await r.call(scope+`/tasks/${task.id}/handoff`,'POST',{targetCatId:r.bob.id,expectedOwnerRevision:0,idempotencyKey:randomUUID(),note:'Review next'});assert.equal(requested.status,202);assert.equal((await requested.json()).status,'requested');
  assert.equal(r.native.tasks.get(task.id).ownerCatId,r.cat.id);const sent=r.native.calls.findLast(c=>c.path==='/api/messages')!.body;assert.deepEqual(sent.mentions,[r.cat.id]);assert.match(sent.content,new RegExp(r.bob.id));
  assert.equal((await r.call(`/bots/Ada/tasks/${task.id}`,'PATCH',{status:'done',expectedOwnerRevision:0})).status,404);
});
test('existing presentation data gains empty workspace fields without losing chat references or preferences',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'bot-legacy-presentation-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'presentation.json'),legacy={version:1,bots:{old:{activeThreadId:'original',folder:'My cats',pinned:true}},groupThreadIds:['group'],folders:['My cats'],messageRefs:{original:{message:1}},deviceName:'My computer'};
  await writeFile(path,JSON.stringify(legacy));const store=new ProductStore(path);assert.equal(store.bot('old').activeThreadId,'original');assert.equal(store.bot('old').pinned,true);assert.deepEqual(store.state.projects,[]);assert.deepEqual(store.state.files,{});store.save();
  const reopened=new ProductStore(path);assert.equal(reopened.messageId('original',1),'message');assert.equal(reopened.state.deviceName,'My computer');assert.deepEqual(reopened.state.groupThreadIds,['group']);
});
test('historical conversations can be renamed and deleted with native sync, active/schedule guards, and soft-delete filtering',async t=>{
  const r=await setup(t),{thread:legacy}=await legacyProject(r);
  const created=await (await r.call('/bots/Ada/new','POST',{expectedThreadId:legacy.id})).json();
  const currentId=created.conversation_id;

  // Rename non-current and current conversations, including legacy project conversation even if renamed to cat.name.
  const badEmpty=await r.call(`/bots/Ada/conversations/${legacy.id}`,'PATCH',{title:'   '});assert.equal(badEmpty.status,400);
  const badLong=await r.call(`/bots/Ada/conversations/${legacy.id}`,'PATCH',{title:'a'.repeat(121)});assert.equal(badLong.status,400);
  const badCtrl=await r.call(`/bots/Ada/conversations/${legacy.id}`,'PATCH',{title:'a\nb'});assert.equal(badCtrl.status,400);
  const renamedLegacy=await r.call(`/bots/Ada/conversations/${legacy.id}`,'PATCH',{title:'  项目复盘  '});assert.equal(renamedLegacy.status,200);
  assert.equal((await renamedLegacy.json()).conversation.title,'项目复盘');
  const renamedCurrent=await r.call(`/bots/Ada/conversations/${currentId}`,'PATCH',{title:'日常对话'});assert.equal(renamedCurrent.status,200);
  let list=await (await r.call('/bots/Ada/conversations')).json();
  assert.equal(list.conversations.find((c:any)=>c.id===legacy.id).title,'项目复盘');
  assert.equal(list.conversations.find((c:any)=>c.id===currentId).title,'日常对话');
  assert.equal((await r.call(`/bots/Ada/conversations/${legacy.id}`,'PATCH',{title:r.cat.name})).status,200);
  list=await (await r.call('/bots/Ada/conversations')).json();
  assert.equal(list.conversations.find((c:any)=>c.id===legacy.id).title,r.cat.name);

  // Foreign / unknown rename rejected.
  const bobThread=await r.bridge.direct(r.bob);
  assert.equal((await r.call(`/bots/Ada/conversations/${bobThread.id}`,'PATCH',{title:'偷改'})).status,404);
  r.store.bot(r.cat.id).conversationIds!.push(bobThread.id);
  assert.equal((await r.call(`/bots/Ada/conversations/${bobThread.id}`,'PATCH',{title:'偷改'})).status,403);
  r.store.bot(r.cat.id).conversationIds=r.store.bot(r.cat.id).conversationIds!.filter(id=>id!==bobThread.id);

  // Delete guards: current conversation, busy queue, enabled schedule, foreign thread.
  assert.equal((await r.call(`/bots/Ada/conversations/${currentId}`,'DELETE')).status,409);
  r.native.queues.set(legacy.id,{queue:[{id:'q1'}],activeInvocations:[]});
  assert.equal((await r.call(`/bots/Ada/conversations/${legacy.id}`,'DELETE')).status,409);
  r.native.queues.clear();
  r.native.schedules=[{id:'dyn-1',enabled:true,deliveryThreadId:legacy.id}];
  assert.equal((await r.call(`/bots/Ada/conversations/${legacy.id}`,'DELETE')).status,409);
  r.native.schedules=[{id:'dyn-1',enabled:false,deliveryThreadId:legacy.id}];

  // Delete legacy conversation succeeds, soft-deletes natively, and removes store references.
  const deleted=await r.call(`/bots/Ada/conversations/${legacy.id}`,'DELETE');assert.equal(deleted.status,200);
  assert.deepEqual(await deleted.json(),{deleted:true});
  assert.ok(r.native.threads.get(legacy.id)?.deletedAt);
  const persisted=new ProductStore(join(r.dir,'presentation.json')).bot(r.cat.id);
  assert.ok(!persisted.conversationIds?.includes(legacy.id));
  assert.ok(!Object.values(persisted.workspaceThreads??{}).includes(legacy.id));
  assert.equal((await r.call(`/bots/Ada/conversations/${legacy.id}`,'DELETE')).status,404);
  assert.equal((await r.call(`/bots/Ada/conversations/${legacy.id}`,'PATCH',{title:'已删'})).status,404);

  // Externally soft-deleted thread is excluded from conversations() and switchConversation().
  r.native.threads.get(r.thread.id)!.deletedAt=Date.now();
  list=await (await r.call('/bots/Ada/conversations')).json();
  assert.ok(!list.conversations.some((c:any)=>c.id===r.thread.id));
  assert.equal((await r.call('/bots/Ada/conversation','PUT',{threadId:r.thread.id,expectedThreadId:currentId})).status,404);
});
test('unsent attachments can be deleted cleanly while sent attachments, deliverables, and symlinks are refused',async t=>{
  const r=await setup(t);
  const {file:unsent}=await (await r.upload('draft.txt',Buffer.from('draft'))).json();
  const {file:sent}=await (await r.upload('sent.txt',Buffer.from('sent'))).json();
  await r.call('/bots/Ada/messages','POST',{text:'hi',attachments:[sent.id],expectedThreadId:r.thread.id,idempotencyKey:randomUUID()});
  r.native.messages.set(r.thread.id,[{id:'m1',type:'user',catId:null,content:'hi',timestamp:1,contentBlocks:[{type:'context_attachment',attachment:{v:1,id:sent.id,kind:'workspace_file',path:sent.path,revision:`sha256:${sent.sha256}`}}]}]);

  // Sent attachment cannot be deleted.
  const sentDel=await r.call(`/bots/Ada/files/${sent.id}`,'DELETE');assert.equal(sentDel.status,409);
  assert.equal(await readFile(sent.path,'utf8'),'sent');

  // Deliverable cannot be deleted via attachment endpoint.
  const root=r.thread.projectPath as string;await writeFile(join(root,'out.md'),'ok');
  const {file:deliv}=await (await r.call('/bots/Ada/deliverables','POST',{path:'out.md',expectedThreadId:r.thread.id})).json();
  assert.equal((await r.call(`/bots/Ada/files/${deliv.id}`,'DELETE')).status,409);

  // Other cat / unknown file: wrong thread returns 409, unknown ID returns 404.
  assert.equal((await r.call(`/bots/Bob/files/${unsent.id}`,'DELETE')).status,409);
  assert.equal((await r.call('/bots/Ada/files/missing-id','DELETE')).status,404);

  // Concurrent send() and deleteAttachment() are coordinated so an accepted message never loses its attachment.
  const {file:raced}=await (await r.upload('race.txt',Buffer.from('important'))).json();
  const origReq=r.native.request.bind(r.native);
  let releaseSend!:()=>void;const sendHeld=new Promise<void>(res=>{releaseSend=res;});
  let enteredPost!:()=>void;const postStarted=new Promise<void>(res=>{enteredPost=res;});
  r.native.request=(async(path:string,opts?:any)=>{
    if(path==='/api/messages'&&opts?.method==='POST'){enteredPost();await sendHeld;}
    return origReq(path,opts);
  }) as typeof r.native.request;
  const sending=r.call('/bots/Ada/messages','POST',{text:'keep',attachments:[raced.id],expectedThreadId:r.thread.id,idempotencyKey:randomUUID()});
  await postStarted;
  const delDuringSend=await r.call(`/bots/Ada/files/${raced.id}`,'DELETE');
  assert.equal(delDuringSend.status,409);
  releaseSend();
  assert.equal((await sending).status,200);
  r.native.request=origReq;
  assert.equal(await readFile(raced.path,'utf8'),'important');

  // Ambiguous send outcome (503/timeout) holds attachment protection; definitive 4xx refusal does not.
  const {file:uncertain}=await (await r.upload('uncertain.txt',Buffer.from('keep-me'))).json();
  const {file:refused}=await (await r.upload('refused.txt',Buffer.from('drop-me'))).json();
  r.native.request=(async(path:string,opts?:any)=>{
    if(path==='/api/messages'&&opts?.method==='POST'){
      if(opts.body.contextAttachments?.[0]?.id===uncertain.id) throw new ApiError(503,'timeout');
      throw new ApiError(409,'refused',{code:'ROUTING_TARGET_UNAVAILABLE',unavailable:[]});
    }
    return origReq(path,opts);
  }) as typeof r.native.request;
  assert.equal((await r.call('/bots/Ada/messages','POST',{text:'hi',attachments:[uncertain.id],expectedThreadId:r.thread.id,idempotencyKey:randomUUID()})).status,503);
  assert.equal((await r.call(`/bots/Ada/files/${uncertain.id}`,'DELETE')).status,409);
  assert.equal((await r.call('/bots/Ada/messages','POST',{text:'hi',attachments:[refused.id],expectedThreadId:r.thread.id,idempotencyKey:randomUUID()})).status,409);
  assert.equal((await r.call(`/bots/Ada/files/${refused.id}`,'DELETE')).status,200);
  r.native.request=origReq;

  // Unsent attachment deletes cleanly: disk file + UUID dir + store record gone.
  const uuidDir=join(root,'.clowder-bot-files',unsent.id);
  const res=await r.call(`/bots/Ada/files/${unsent.id}`,'DELETE');assert.equal(res.status,200);
  assert.deepEqual(await res.json(),{deleted:true});
  await assert.rejects(stat(unsent.path));await assert.rejects(stat(uuidDir));
  assert.equal(new ProductStore(join(r.dir,'presentation.json')).state.files[unsent.id],undefined);
  assert.equal((await fetch(r.base+unsent.url)).status,404);

  // Group unsent attachment also deletes cleanly.
  const group=await (await r.call('/groups','POST',{name:'Team',members:['Ada','Bob']})).json();
  const gu=await fetch(`${r.base}/xbot-api/groups/${group.id}/files?${new URLSearchParams({name:'g.txt',expectedThreadId:group.id})}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Buffer.from('g')});
  const {file:gFile}=await gu.json();
  assert.equal((await r.call(`/groups/${group.id}/files/${gFile.id}`,'DELETE')).status,200);

  // Symlink guard refuses tampering.
  const {file:symFile}=await (await r.upload('safe.txt',Buffer.from('ok'))).json();
  await rm(symFile.path);await writeFile(join(r.dir,'target.txt'),'secret');await symlink(join(r.dir,'target.txt'),symFile.path);
  assert.equal((await r.call(`/bots/Ada/files/${symFile.id}`,'DELETE')).status,403);
  assert.equal(await readFile(join(r.dir,'target.txt'),'utf8'),'secret');
});
test('workspace directory files support restricted text and raster image preview without executing HTML/SVG or traversing symlinks',async t=>{
  const r=await setup(t),{project,thread}=await legacyProject(r),root=thread.projectPath as string;
  const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13]);
  await mkdir(join(root,'sub'),{recursive:true});
  await writeFile(join(root,'sub','long.txt'),Buffer.alloc(140000,66));
  await writeFile(join(root,'page.html'),'<script>alert(1)</script>');
  await writeFile(join(root,'icon.svg'),'<svg onload="alert(1)"/>');
  await writeFile(join(root,'pic.png'),png);
  await writeFile(join(root,'fake.png'),'<script>alert(1)</script>');
  await writeFile(join(root,'bin.dat'),Buffer.from([0,1,2,3]));
  await writeFile(join(project.sharedPath,'shared.md'),'# Shared');
  await writeFile(join(r.dir,'outside.txt'),'secret');
  await symlink(join(r.dir,'outside.txt'),join(root,'escape.txt'));

  const tree=await (await r.call('/bots/Ada/workspace-tree')).json();
  const byName=(name:string)=>tree.entries.find((e:any)=>e.name===name);
  assert.equal(byName('page.html').previewable,'text');
  assert.equal(byName('pic.png').previewable,'image');
  assert.equal(byName('icon.svg').previewable,null);
  assert.equal(byName('bin.dat').previewable,null);

  const tid=encodeURIComponent(thread.id);
  // Bounded plain-text preview for text and HTML source (CSP sandbox, JSON only).
  const textRes=await r.call(`/bots/Ada/workspace-file/preview?path=sub%2Flong.txt&area=workspace&expectedThreadId=${tid}`);
  assert.equal(textRes.status,200);
  assert.match(textRes.headers.get('content-security-policy')!,/default-src 'none'; sandbox/);
  assert.equal(textRes.headers.get('x-content-type-options'),'nosniff');
  const textJson=await textRes.json();assert.equal(textJson.text.length,128*1024);assert.equal(textJson.truncated,true);

  const htmlRes=await r.call(`/bots/Ada/workspace-file/preview?path=page.html&area=workspace&expectedThreadId=${tid}`);
  assert.equal(htmlRes.status,200);assert.match(htmlRes.headers.get('content-type')!,/application\/json/);
  assert.equal((await htmlRes.json()).text,'<script>alert(1)</script>');

  // Shared area preview works on legacy project thread; stale expectedThreadId is rejected (409).
  const sharedRes=await r.call(`/bots/Ada/workspace-file/preview?path=shared.md&area=shared&expectedThreadId=${tid}`);
  assert.equal(sharedRes.status,200);assert.equal((await sharedRes.json()).text,'# Shared');
  assert.equal((await r.call('/bots/Ada/workspace-file/preview?path=shared.md&area=shared&expectedThreadId=stale-thread')).status,409);
  assert.equal((await r.call('/bots/Ada/workspace-file/image?path=pic.png&area=workspace&expectedThreadId=stale-thread')).status,409);

  // Raster image preview works; SVG and fake PNG are rejected with 415.
  const imgRes=await r.call(`/bots/Ada/workspace-file/image?path=pic.png&area=workspace&expectedThreadId=${tid}`);
  assert.equal(imgRes.status,200);assert.equal(imgRes.headers.get('content-type'),'image/png');
  assert.match(imgRes.headers.get('content-security-policy')!,/default-src 'none'; sandbox/);
  assert.deepEqual(Buffer.from(await imgRes.arrayBuffer()),png);
  assert.equal((await r.call(`/bots/Ada/workspace-file/image?path=icon.svg&area=workspace&expectedThreadId=${tid}`)).status,415);
  assert.equal((await r.call(`/bots/Ada/workspace-file/preview?path=icon.svg&area=workspace&expectedThreadId=${tid}`)).status,415);
  assert.equal((await r.call(`/bots/Ada/workspace-file/image?path=fake.png&area=workspace&expectedThreadId=${tid}`)).status,415);
  assert.equal((await r.call(`/bots/Ada/workspace-file/preview?path=bin.dat&area=workspace&expectedThreadId=${tid}`)).status,415);

  // Traversal, hidden files, symlinks, and directories are rejected.
  for(const bad of ['../outside.txt','escape.txt','.env','sub','/etc/passwd']) {
    assert.ok([400,403,404].includes((await r.call(`/bots/Ada/workspace-file/preview?path=${encodeURIComponent(bad)}&area=workspace&expectedThreadId=${tid}`)).status));
    assert.ok([400,403,404].includes((await r.call(`/bots/Ada/workspace-file/image?path=${encodeURIComponent(bad)}&area=workspace&expectedThreadId=${tid}`)).status));
  }

  // Group workspace file preview works too.
  const group=await (await r.call('/groups','POST',{name:'Team',members:['Ada','Bob']})).json();
  const gRoot=r.native.threads.get(group.id)!.projectPath as string;
  await writeFile(join(gRoot,'notes.txt'),'group note');
  const gRes=await r.call(`/groups/${group.id}/workspace-file/preview?path=notes.txt&area=workspace&expectedThreadId=${encodeURIComponent(group.id)}`);
  assert.equal(gRes.status,200);assert.equal((await gRes.json()).text,'group note');
});
