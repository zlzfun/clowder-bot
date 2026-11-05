import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
if(process.env.BOT_WORKSPACE_AGENT_TEST!=='1')throw new Error('Explicit isolated Agent acceptance opt-in required.');
const e=JSON.parse(await readFile('.runtime/workspaces-http-evidence.json','utf8'));
assert.equal(new URL(e.base).hostname,'127.0.0.1');
const scope='/xbot-api/bots/'+encodeURIComponent(e.names[0]);
const response=await fetch(e.base+scope+'/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
  text:'这是隔离工作区验收。请读取本条消息附带的需求说明文件，找到 WORKSPACE_TOKEN_ 开头的标识；在你当前工作目录创建 agent-delivery.md，写入该标识和一行简短结论。最后只回复 AGENT_WORKSPACE_OK 和标识。不要读写工作目录之外的其他文件，不要访问网络。',
  attachments:[e.file.id],expectedThreadId:e.work.threadId,idempotencyKey:randomUUID(),
})});
assert.equal(response.status,200);console.log('Native admission:',await response.text());
const deadline=Date.now()+240000;let success;
while(Date.now()<deadline){
  const transcript=await(await fetch(e.base+scope+'/transcript')).json();
  const reply=transcript.messages?.find(m=>m.role==='assistant'&&m.content?.includes('AGENT_WORKSPACE_OK')&&m.content?.includes(e.token));
  if(reply){const file=await readFile(join(e.work.workspacePath,'agent-delivery.md'),'utf8');assert.match(file,new RegExp(e.token));success={messageId:reply.native_message_id,threadId:e.work.threadId,content:reply.content,file};break;}
  await new Promise(r=>setTimeout(r,3000));
}
assert.ok(success,'Agent did not produce the expected reply and file within 4 minutes');
await writeFile('.runtime/workspace-agent-evidence.json',JSON.stringify(success,null,2)+'\n');console.log(JSON.stringify({passed:true,...success}));
