import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, symlink } from 'node:fs/promises';
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
