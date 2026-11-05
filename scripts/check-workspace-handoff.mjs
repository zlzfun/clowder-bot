import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

if(process.env.BOT_WORKSPACE_HANDOFF_TEST!=='1')throw new Error('Explicit isolated Agent handoff acceptance opt-in required.');
const e=JSON.parse(await readFile(process.env.BOT_WORKSPACE_EVIDENCE||'.runtime/workspaces-http-evidence.json','utf8'));
assert.equal(new URL(e.base).hostname,'127.0.0.1');
const scope='/xbot-api/groups/'+encodeURIComponent(e.group.id);
async function call(path,method='GET',body){
  const r=await fetch(e.base+path,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  const data=await r.json();assert.ok(r.ok,`${method} ${path}: ${r.status} ${JSON.stringify(data)}`);return data;
}
const {task}=await call(scope+'/tasks','POST',{title:'真实猫猫交接验收',why:'只验证 Task 交接，不修改文件或访问网络。',ownerCatId:e.cats[1].native_id,expectedThreadId:e.group.id});
const receipt=await call(scope+`/tasks/${task.id}/handoff`,'POST',{targetCatId:e.cats[0].native_id,expectedOwnerRevision:task.ownerRevision??0,idempotencyKey:randomUUID(),note:'这是隔离测试。请正式交接本 Task；目标成员只需确认收到，不继续转派，不修改任何文件，不访问网络。'});
assert.equal(receipt.status,'requested');console.log('Handoff request admitted:',task.id);
const deadline=Date.now()+240000;let confirmed;
while(Date.now()<deadline){
  const native=await call('/native-api/api/tasks/'+task.id);
  if(native.ownerCatId===e.cats[0].native_id){
    const row=native.assignmentHistory?.find(h=>h.kind==='handoff'&&h.fromCatId===e.cats[1].native_id&&h.toCatId===e.cats[0].native_id);
    assert.ok(row,'An actual native handoff receipt must accompany the ownership change');assert.ok(row.sourceMessageRef?.startsWith('message:'));
    confirmed=native;break;
  }
  await new Promise(resolve=>setTimeout(resolve,2500));
}
assert.ok(confirmed,'The native owner did not confirm the requested handoff within 4 minutes');
await writeFile(process.env.BOT_HANDOFF_EVIDENCE||'.runtime/workspace-handoff-evidence.json',JSON.stringify({task:confirmed,receipt},null,2)+'\n');
console.log(JSON.stringify({passed:true,taskId:task.id,owner:confirmed.ownerCatId,history:confirmed.assignmentHistory}));
