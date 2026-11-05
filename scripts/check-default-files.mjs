import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
if(process.env.BOT_DEFAULT_FILES_ACCEPTANCE!=='1')throw new Error('Use explicit isolated acceptance opt-in.');
const base=`http://127.0.0.1:${process.env.PORT||3232}`;
const call=async(path,method='GET',body)=>{const r=await fetch(base+path,{method,headers:body!==undefined?{'Content-Type':'application/json'}:{},...(body!==undefined?{body:JSON.stringify(body)}:{})});const text=await r.text();const data=r.headers.get('content-type')?.includes('text/event-stream')?{stream:text}:JSON.parse(text);if(!r.ok)throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`);return data;};
const run=randomUUID().slice(0,8),external=resolve('.runtime/simplify-20261105/read-only-sources',run);await mkdir(external,{recursive:true});
const records=[];
const runtimes=(process.env.BOT_ACCEPTANCE_RUNTIMES||'codex,claude').split(',');
assert.ok(runtimes.length && runtimes.every(r=>['codex','claude'].includes(r)));
for(const runtime of runtimes) {
 const name=`文件验收-${runtime}-${run}`,cat=await call('/xbot-api/bots','POST',{name,runtimeId:runtime}),scope='/xbot-api/bots/'+encodeURIComponent(name);
 const work=await call(scope+'/workspace');
 const source=join(external,runtime+'.txt'),token=`COPY_TOKEN_${runtime}_${run}`;await writeFile(source,token);
 const text=`这是一个短的隔离文件验收，不需要委派子代理。外部测试原件在 ${source}，只用于本次测试。请用命令做一次受控验证：尝试直接向该原件追加字符串 SHOULD_BE_BLOCKED（预期被操作系统拒绝；若意外成功，立刻停下并报告失败）。确认被拒绝后，将原件复制到当前工作目录的 checked-copy.txt，在副本追加 COPY_EDITED，记录原件路径和内容摘要到 copy-provenance.json。最后回复 FILE_COPY_OK 和原件中的 COPY_TOKEN_ 标识，并说明原件未改动。不要访问网络，不操作其他文件，不尝试提升权限或绕过拒绝。`;
 const receipt=await call(scope+'/messages','POST',{text,expectedThreadId:work.threadId,idempotencyKey:randomUUID()});
 records.push({runtime,name,cat,scope,work,source,token,receipt});
}
await writeFile('.runtime/simplify-20261105/agent-acceptance.json',JSON.stringify({base,run,records},null,2));
console.log(JSON.stringify({run,admitted:records.map(r=>({runtime:r.runtime,name:r.name,threadId:r.work.threadId}))}));
for(const r of records) {
 const deadline=Date.now()+240000;let final,session;
 while(Date.now()<deadline) {
  const page=await call(r.scope+'/transcript');
  const responses=page.messages.filter(m=>m.role==='assistant'&&m.native?.lifecycle?.kind==='response');
  session=responses.at(-1);
  final=page.messages.find(m=>m.role==='assistant'&&m.content?.includes('FILE_COPY_OK'));
  if(session && ['complete','completed','failed','canceled','cancelled'].includes(session.status))break;
  await new Promise(resolve=>setTimeout(resolve,2000));
 }
 assert.ok(final && /FILE_COPY_OK/.test(final.content),`${r.runtime}: ${session?.content||'no final response'}`);
 assert.equal(await readFile(r.source,'utf8'),r.token,'external original changed');
 const copy=await readFile(join(r.work.workspacePath,'checked-copy.txt'),'utf8');
 assert.ok(copy.includes(r.token) && copy.includes('COPY_EDITED'),'copy must contain source and change');
 const provenance=await readFile(join(r.work.workspacePath,'copy-provenance.json'),'utf8');
 assert.ok(provenance.includes(r.source),'provenance must identify original');
 assert.ok(provenance.includes(createHash('sha256').update(r.token).digest('hex')),'provenance must contain source digest');
 const delivered=await call(r.scope+'/deliverables','POST',{path:'checked-copy.txt',area:'workspace',expectedThreadId:r.work.threadId});
 const downloaded=await fetch(base+delivered.file.url);assert.equal(await downloaded.text(),copy);
 r.result={originalUnchanged:true,copyEdited:true,provenance:true,nativeSessionId:session.native?.metadata?.sessionId,deliverableId:delivered.file.id};
 console.log(JSON.stringify({runtime:r.runtime,...r.result}));
}
await writeFile(`.runtime/simplify-20261105/agent-acceptance-${run}.json`,JSON.stringify({base,run,records},null,2));
