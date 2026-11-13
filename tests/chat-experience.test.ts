import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { ProductStore } from '../server/product-store.js';
import { ApiError } from '../server/errors.js';
import { NativeClient } from '../server/native/client.js';
import { nativeUploadPath } from '../server/native/file-path.js';
import { NativeFixture } from './native-fixture.js';
import type { NativeMessage } from '../server/native/types.js';

async function setup(t:any) {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'bot-chat-experience-'))), workspace=join(dir,'workspace');await mkdir(workspace);
  const native=new NativeFixture(),runtime=createApp({native,workspace,dataFile:join(dir,'presentation.json')});
  const server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address();assert.ok(addr&&typeof addr!=='string');
  t.after(async()=>{await runtime.close();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});});
  const cat=await runtime.bridge.createBot({name:'Ada'}),thread=await runtime.bridge.direct(cat);await mkdir(String(thread.projectPath),{recursive:true});
  const call=(path:string,method='GET',body?:unknown)=>fetch(`http://127.0.0.1:${addr.port}/xbot-api${path}`,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const reply=(id:string,timestamp:number,content='回复'):NativeMessage=>({id,type:'assistant',catId:cat.id,timestamp,content});
  return {...runtime,native,dir,cat,thread,call,reply};
}

test('native file-only replies survive projection and authorized downloads; snapshots are not duplicated',async t=>{
  const r=await setup(t),message={...r.reply('file-reply',1000,''),extra:{rich:{blocks:[{id:'report',kind:'file',fileName:'report.txt',url:'/uploads/report.txt',mimeType:'text/plain'}]}}};
  r.native.messages.set(r.thread.id,[message]);r.native.uploads.set('/uploads/report.txt',Buffer.from('final report'));
  r.native.artifactRows.set(r.thread.id,[{type:'file',sourceMessageId:message.id,publicationItem:{kind:'rich-file',blockId:'report'},name:'report.txt',createdAt:1000}]);
  const transcript=await(await r.call('/bots/Ada/transcript')).json();
  const row=transcript.messages.find((m:any)=>m.id===message.id&&m.role==='assistant');assert.ok(row);assert.equal(row.content,'');
  const file=row.attachments[0];assert.equal(file.nativeSource,true);assert.equal(file.availability,'available');assert.equal(file.size,null);
  const downloaded=await r.call(`/files/${file.id}/download`);assert.equal(downloaded.status,200);assert.equal(await downloaded.text(),'final report');
  assert.match(downloaded.headers.get('content-disposition')!,/^attachment/);assert.match(downloaded.headers.get('content-security-policy')!,/sandbox/);
  const preview=await(await r.call(`/files/${file.id}/preview`)).json();assert.equal(preview.text,'final report');
  const listing=await(await r.call('/bots/Ada/files')).json();assert.equal(listing.nativeReadStatus,'ready');assert.equal(listing.files[0].id,file.id);
  assert.deepEqual(r.store.state.files,{},'native publication views must not create duplicate snapshots');
  assert.equal((await r.bridge.activity.read(r.thread.id)).unread,1);
});

test('file coordinates recheck owner access, source changes and removal instead of fetching stale or arbitrary URLs',async t=>{
  const r=await setup(t),block={type:'file',fileName:'ok.txt',url:'/uploads/ok.txt',mimeType:'text/plain'};
  r.native.messages.set(r.thread.id,[{...r.reply('m1',1000,''),contentBlocks:[block]}]);r.native.uploads.set(block.url,Buffer.from('ok'));
  const file=r.bridge.workspaces.messageFiles(r.thread.id,r.native.messages.get(r.thread.id)![0]!)[0]!;
  r.native.messages.set(r.thread.id,[{...r.reply('m1',1000,''),contentBlocks:[{...block,url:'/uploads/changed.txt'}]}]);
  assert.equal((await r.call(`/files/${file.id}/download`)).status,409);
  assert.equal(r.native.calls.filter(c=>c.method==='BYTES').length,0);
  r.native.messages.set(r.thread.id,[]);assert.equal((await r.call(`/files/${file.id}/download`)).status,404);
  r.native.threads.delete(r.thread.id);assert.equal((await r.call(`/files/${file.id}/download`)).status,404);
  for(const url of ['https://example.com/private','/api/accounts','/uploads/../secret','/uploads/%2e%2e/secret','/uploads/%252e%252e/secret']){
    const view=r.bridge.nativeFiles.project(r.thread.id,{...r.reply('external',2000,''),contentBlocks:[{...block,url}]})[0]!;
    assert.equal(view.availability,'unavailable');
  }
});

test('file catalogue failure preserves existing snapshots and exposes partial read',async t=>{
  const r=await setup(t);await r.bridge.workspaces.saveFile(r.thread,'kept.txt',Buffer.from('kept'),'attachment');
  const request=r.native.request.bind(r.native);r.native.request=async(path,options)=>{if(path.endsWith('/artifacts'))throw new ApiError(503,'catalog down');return request(path,options);};
  const listing=await(await r.call('/bots/Ada/files')).json();assert.equal(listing.nativeReadStatus,'unavailable');assert.equal(listing.files.length,1);assert.equal(listing.files[0].name,'kept.txt');
  const download=await r.call(`/files/${listing.files[0].id}/download`);assert.equal(await download.text(),'kept');
});

test('native bytes cannot execute active content or spoof an image preview',async t=>{
  const r=await setup(t);r.native.messages.set(r.thread.id,[{...r.reply('html',1000,''),contentBlocks:[{type:'file',fileName:'fake.png',mimeType:'image/png',url:'/uploads/fake.png'}]}]);
  r.native.uploads.set('/uploads/fake.png',Buffer.from('<script>bad()</script>'));
  const file=r.bridge.nativeFiles.project(r.thread.id,r.native.messages.get(r.thread.id)![0]!)[0]!;
  assert.equal((await r.call(`/files/${file.id}/image`)).status,415);
  assert.equal((await r.call(`/files/${file.id}/preview`)).status,415);
  assert.equal((await r.call(`/files/${file.id}/download`)).headers.get('content-type'),'application/octet-stream');
});

test('conversation reads do not acknowledge replies; explicit acknowledgements are monotonic and thread-scoped',async t=>{
  const r=await setup(t),one=r.reply('reply-1',1000),two=r.reply('reply-2',2000);r.native.messages.set(r.thread.id,[one,two]);
  await r.call('/bots/Ada/transcript');await r.call('/bots/Ada/activity');await r.call('/bots/status');
  assert.deepEqual(r.store.state.readCursors,{});assert.equal(r.store.bot(r.cat.id).lastReadMessageId,undefined);
  assert.equal((await(await r.call('/bots/Ada/activity')).json()).unread,2);
  const ack=await r.call('/bots/Ada/read','POST',{expectedThreadId:r.thread.id,messageId:two.id});assert.equal(ack.status,200);
  await r.call('/bots/Ada/read','POST',{expectedThreadId:r.thread.id,messageId:one.id});
  assert.equal(r.store.state.readCursors[r.thread.id]?.messageId,two.id);assert.equal((await r.bridge.activity.read(r.thread.id)).unread,0);
  assert.equal((await r.call('/bots/Ada/read','POST',{expectedThreadId:'wrong',messageId:two.id})).status,409);
  assert.equal((await r.call('/bots/Ada/read','POST',{expectedThreadId:r.thread.id,messageId:'foreign'})).status,404);
  const other=await r.bridge.newThread('group',[r.cat.id]);r.store.state.groupThreadIds.push(other.id);r.native.messages.set(other.id,[r.reply('group-reply',3000)]);
  assert.equal((await(await r.call(`/groups/${other.id}/activity`)).json()).unread,1);
  const reopened=new ProductStore(join(r.dir,'presentation.json'));assert.equal(reopened.state.readCursors[r.thread.id]?.messageId,two.id);
  const saved=JSON.parse(await readFile(join(r.dir,'presentation.json'),'utf8'));assert.equal(saved.messages,undefined);assert.equal(saved.memories,undefined);
});

test('pending drafts and duplicated execution summaries do not count as new replies',async t=>{
  const r=await setup(t),extra={stream:{turnInvocationId:'turn'}};
  r.native.messages.set(r.thread.id,[{...r.reply('draft',1000),isDraft:true},{...r.reply('stream',1100),origin:'stream',extra},
    {...r.reply('explicit',1200),origin:'callback',extra:{...extra,isExplicitPost:true}},
    {...r.reply('stopped',1300),lifecycle:{kind:'response',status:'canceled'}},r.reply('silent',1400,'SILENT')]);
  const view=await r.bridge.activity.read(r.thread.id);assert.equal(view.unread,1);assert.equal(view.latestMessageId,'explicit');
  assert.equal((await r.call('/bots/Ada/read','POST',{expectedThreadId:r.thread.id,messageId:'draft'})).status,404);
  assert.equal((await r.call('/bots/Ada/read','POST',{expectedThreadId:r.thread.id,messageId:'silent'})).status,404);
  r.native.messages.get(r.thread.id)!.push({...r.reply('silent-file',1500,'SILENT'),contentBlocks:[{type:'file',fileName:'report.txt',url:'/uploads/report.txt'}]});
  const withFile=await r.bridge.activity.read(r.thread.id);assert.equal(withFile.unread,2);assert.equal(withFile.latestMessageId,'silent-file');
});

test('a conversation says what was said last: the owner counts, the invitation, drafts and execution summaries do not',async t=>{
  const r=await setup(t),last=async()=>(await r.bridge.activity.read(r.thread.id)).last;
  assert.equal(await last(),null,'nothing said yet');
  const user=(id:string,timestamp:number,content:string):NativeMessage=>({id,type:'user',catId:null,timestamp,content});
  // The opening invitation the app sent for the owner is not something the owner said.
  r.store.bot(r.cat.id).greetingSources={[r.thread.id]:'invite'};
  r.native.messages.set(r.thread.id,[user('invite',900,'聊天页的开场邀请…')]);
  assert.equal(await last(),null);
  r.native.messages.get(r.thread.id)!.push(r.reply('hello',1000,'你好呀，\n我是 Ada。\n\n[Ada/gpt🐾]'));
  assert.deepEqual(await last(),{messageId:'hello',time:new Date(1000).toISOString(),from:'cat',catId:r.cat.id,catName:'Ada',text:'你好呀， 我是 Ada。',files:0});
  r.native.messages.get(r.thread.id)!.push(user('ask',2000,'帮我看看这份资料'));
  assert.deepEqual(await last(),{messageId:'ask',time:new Date(2000).toISOString(),from:'owner',text:'帮我看看这份资料',files:0});
  // A reply still being written, an execution summary and a silent turn leave the line as it was.
  const extra={stream:{turnInvocationId:'turn'}};
  r.native.messages.get(r.thread.id)!.push({...r.reply('draft',2100,'写到一半'),isDraft:true},r.reply('silent',2300,'SILENT'));
  assert.equal((await last())!.messageId,'ask');
  r.native.messages.get(r.thread.id)!.push({...r.reply('stream',2350,'过程记录'),origin:'stream',extra},
    {...r.reply('explicit',2400,'看完了。'+'长'.repeat(200)),origin:'callback',extra:{...extra,isExplicitPost:true}});
  const long=(await last())!;assert.equal(long.messageId,'explicit');assert.equal(long.text.length,140);assert.ok(long.text.endsWith('…'));
  // A reply that is only a file says so by count, not by made-up words.
  r.native.messages.get(r.thread.id)!.push({...r.reply('file',2500,'SILENT'),contentBlocks:[{type:'file',fileName:'report.txt',url:'/uploads/report.txt'}]});
  assert.deepEqual(await last(),{messageId:'file',time:new Date(2500).toISOString(),from:'cat',catId:r.cat.id,catName:'Ada',text:'',files:1});
  // A signed silence or a signature alone is not a reply, so it neither becomes the line nor counts as unread.
  const before=await r.bridge.activity.read(r.thread.id);
  r.native.messages.get(r.thread.id)!.push(r.reply('signed-silent',2600,'SILENT\n\n[Ada/gpt🐾]'),r.reply('signature-only',2700,'[Ada/gpt🐾]'));
  const after=await r.bridge.activity.read(r.thread.id);
  assert.equal(after.last!.messageId,'file');assert.equal(after.unread,before.unread);assert.equal(after.latestMessageId,'file');
  // A cut inside an emoji would leave half a character.
  r.native.messages.get(r.thread.id)!.push(r.reply('emoji',2800,'a'.repeat(138)+'🐱b'));
  assert.equal((await last())!.text,'a'.repeat(138)+'…');
  // A cat writes Markdown; the list shows its words, not the marks. What the owner typed stays as typed.
  r.native.messages.get(r.thread.id)!.push(r.reply('marked',2900,'## 结论\n\n看过说明，要点写进了 `结果.md`。\n\n简单说：纸箱让猫觉得**安全又暖和**。'));
  assert.equal((await last())!.text,'结论 看过说明，要点写进了 结果.md。 简单说：纸箱让猫觉得安全又暖和。');
  r.native.messages.get(r.thread.id)!.push({id:'typed',type:'user',content:'**加粗**是这样写的吗',timestamp:2950,threadId:r.thread.id,userId:'clowder-bot-owner'} as never);
  assert.equal((await last())!.text,'**加粗**是这样写的吗');
  r.native.messages.get(r.thread.id)!.push(r.reply('emoji2',2990,'a'.repeat(138)+'🐱b'));
  // The status read carries it for each cat; a conversation that cannot be read has none.
  const status=await(await r.call('/bots/status')).json();assert.equal(status.bots[0].activity.last.messageId,'emoji2');
  assert.equal(r.bridge.activity.unavailable(r.thread.id).last,null);
});
test('an invitation whose receipt has not come back yet is still not something the owner said',async t=>{
  const r=await setup(t);
  // Native published the invitation; the adapter has only recorded that it asked.
  r.store.bot(r.cat.id).greetingSources={[r.thread.id]:{invitationVersion:2}};
  await r.bridge.greet(r.cat,r.thread.id).catch(()=>{});
  const sent=r.native.calls.findLast(c=>c.path==='/api/messages'&&c.method==='POST')!.body.content as string;
  r.store.bot(r.cat.id).greetingSources={[r.thread.id]:{invitationVersion:2}};
  r.native.messages.set(r.thread.id,[{id:'pending-invite',type:'user',catId:null,timestamp:900,content:sent}]);
  assert.equal((await r.bridge.activity.read(r.thread.id)).last,null);
  // The same words typed by the owner in a chat that has no pending invitation are the owner's.
  r.store.bot(r.cat.id).greetingSources={};
  assert.equal((await r.bridge.activity.read(r.thread.id)).last!.messageId,'pending-invite');
});
test('group replies retain failed and file-only messages without showing silent control markers',async t=>{
  const r=await setup(t),group=await r.bridge.newThread('Group',[r.cat.id]);r.store.state.groupThreadIds.push(group.id);
  r.native.messages.set(group.id,[r.reply('silent',1000,'SILENT'),{...r.reply('failed',1100,''),lifecycle:{kind:'response',status:'failed'}},
    {...r.reply('file',1200,'SILENT'),contentBlocks:[{type:'file',fileName:'report.txt',url:'/uploads/report.txt'}]}]);
  const page=await(await r.call(`/groups/${group.id}`)).json();assert.deepEqual(page.messages.map((m:any)=>m.id),['failed','file']);
  assert.equal(page.messages[0].text,'这次没完成');assert.equal(page.messages[1].text,'');assert.equal(page.messages[1].attachments.length,1);
  const activity=await r.bridge.activity.read(group.id);assert.equal(activity.unread,2);assert.equal(activity.latestMessageId,'file');
});

test('native approvals, concurrent work and failed replies remain distinct; task progress cannot manufacture execution',async t=>{
  const r=await setup(t);r.native.queues.set(r.thread.id,{queue:[{id:'q',status:'queued',targetCatId:r.cat.id}],activeInvocations:[{catId:r.cat.id,invocationId:'active'}]});
  r.native.taskRows=[{id:'task',threadId:r.thread.id,title:'Report',ownerCatId:r.cat.id,status:'blocked'},
    {id:'done',threadId:r.thread.id,title:'Other',ownerCatId:r.cat.id,status:'done'}];
  const approval=(id:string,threadId=r.thread.id,resolution='open')=>({proposalId:id,sourceFeatureId:'F306',requesterCatId:r.cat.id,resolution,summary:'Please confirm',navigation:{state:'anchored',approvalCardRef:{threadId,messageId:`card-${id}`}}});
  r.native.approvalItems=[approval('a'),approval('b'),approval('foreign','other'),approval('closed',r.thread.id,'accepted')];
  r.native.messages.set(r.thread.id,[{...r.reply('failed',2000,''),lifecycle:{kind:'response',status:'failed'}}]);
  const view=await(await r.call('/bots/Ada/activity')).json();assert.equal(view.readStatus,'ready');
  assert.deepEqual(view.counts,{approval:2,failure:1,running:1,queued:1,task:1});assert.equal(view.items[0].messageId,'card-a');
  const statuses=await(await r.call('/bots/status')).json();assert.equal(statuses.bots[0].state,'awaiting');assert.equal(statuses.bots[0].activity.counts.approval,2);
  r.native.queues.set(r.thread.id,{queue:[],activeInvocations:[]});r.native.approvalItems=[];
  const idle=await r.bridge.activity.read(r.thread.id);assert.equal(idle.counts.running,0);assert.equal(idle.counts.task,1);
});

test('partial native reads preserve known work and never report false idle',async t=>{
  const r=await setup(t),request=r.native.request.bind(r.native);
  r.native.request=async(path,options)=>{if(path.endsWith('/queue'))throw new ApiError(503,'offline');return request(path,options);};
  const view=await(await r.call('/bots/Ada/activity')).json();assert.equal(view.readStatus,'partial');assert.equal(view.errors[0].source,'queue');
  assert.equal((await(await r.call('/bots/status')).json()).bots[0].state,'unknown');
  r.native.request=async(path,options)=>{if(path.startsWith('/api/messages?'))throw new ApiError(503,'offline');return request(path,options);};
  assert.equal((await r.bridge.activity.read(r.thread.id)).unread,null);
});

test('read-only owner memory projects canonical content without applying candidates or exposing writers',async t=>{
  const r=await setup(t),revision='sha256:'+'a'.repeat(64);
  r.native.memoryViews.profile={readStatus:'ready',entries:[{id:'capsule',title:'About',content:'已保存资料',status:'active',revision,proposals:[{status:'pending',suggestedContent:'不要替换成这个'}]}]};
  r.native.memoryViews.taste={readStatus:'partial',entries:[{id:'taste-abc',title:'偏好',takeaway:'先给结论',quotes:['用户原话'],scene:'讨论时',status:'active',revision,takeawayCandidate:{status:'pending_owner_confirmation',takeaway:'未确认内容'}}]};
  const profile=await(await r.call('/memory/profile')).json();assert.equal(profile.entries[0].content,'已保存资料');assert.equal(profile.entries[0].pendingCount,1);
  const taste=await(await r.call('/memory/taste')).json();assert.equal(taste.readStatus,'partial');assert.match(taste.entries[0].content,/先给结论/);assert.doesNotMatch(taste.entries[0].content,/未确认内容/);
  assert.equal((await r.call(`/memory/profile/capsule/source?revision=${revision}`)).status,200);
  assert.equal((await r.call('/memory/profile/capsule/source?revision=old')).status,400);
  for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await r.call('/memory/profile/capsule/actions',method,{action:'hard_forget'})).status,405);
  assert.equal((await r.call('/groups/unknown/memory/profile')).status,404);
  assert.ok(r.native.calls.filter(c=>c.path.startsWith('/api/memory/profile')||c.path.startsWith('/api/memory/taste')).every(c=>c.method==='GET'));
  assert.equal(r.store.state.files&&Object.keys(r.store.state.files).length,0);
});

test('memory authorization, stale revisions and unavailable data remain errors, not empty success',async t=>{
  const r=await setup(t),request=r.native.request.bind(r.native);
  for(const status of [401,403,409,503]){
    r.native.request=async(path,options)=>{if(path.startsWith('/api/memory/profile'))throw new ApiError(status,'native unavailable');return request(path,options);};
    assert.equal((await r.call('/memory/profile')).status,status);
  }
});

test('memory source projection preserves the distinct native Profile and Taste contracts',async t=>{
  const r=await setup(t),request=r.native.request.bind(r.native),revision='sha256:'+'b'.repeat(64);
  let taste:Record<string,unknown>={status:'ready',title:'原始对话',canOpen:true,threadId:r.thread.id,messageId:'source-message'};
  const profile={status:'ready',sources:[{label:'画像来源',occurredAt:1000,canOpen:true,threadId:r.thread.id,messageId:'profile-message'}]};
  r.native.request=async(path,options)=>path.includes('/source?')?(path.includes('/profile/')?profile:taste) as any:request(path,options);
  assert.deepEqual(await(await r.call(`/memory/profile/capsule/source?revision=${revision}`)).json(),profile);
  const result=await(await r.call(`/memory/taste/taste-example/source?revision=${revision}`)).json();
  assert.deepEqual(result,{status:'ready',sources:[{label:'原始对话',occurredAt:null,canOpen:true,threadId:r.thread.id,messageId:'source-message'}]});
  for(const status of ['not_recorded','unavailable']){taste={status,title:null,canOpen:false};assert.deepEqual(await(await r.call(`/memory/taste/taste-example/source?revision=${revision}`)).json(),{status,sources:[]});}
});

test('native byte transport bounds reads, uses only loopback uploads and refuses redirects and traversal',async()=>{
  for(const path of ['/api/accounts','https://evil.test/a','//evil.test/a','/uploads/../a','/uploads/%2Fetc','/uploads/%252e%252e/a','/uploads/a?url=bad'])assert.equal(nativeUploadPath(path),null);
  const calls:Array<{url:string;init:RequestInit|undefined}>=[];
  const client=new NativeClient('http://127.0.0.1:4331','http://127.0.0.1:3210',async(input,init)=>{
    calls.push({url:String(input),init});
    if(String(input).endsWith('/api/session'))return new Response(JSON.stringify({userId:'clowder-bot-owner',csrfToken:'csrf'}),{headers:{'Set-Cookie':'clowder_bot_native_session=fixture; HttpOnly'}});
    return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(8));controller.enqueue(new Uint8Array(8));controller.close();}}));
  });
  await assert.rejects(client.readFile('/api/accounts',10),/来源不可访问/);assert.equal(calls.length,0);
  await assert.rejects(client.readFile('/uploads/file.txt',10),/20 MB/);
  const bytesCall=calls.at(-1)!;assert.equal(bytesCall.url,'http://127.0.0.1:4331/uploads/file.txt');assert.equal(bytesCall.init?.redirect,'error');
  assert.equal(new Headers(bytesCall.init?.headers).get('Cookie'),'clowder_bot_native_session=fixture');await client.close();
});
