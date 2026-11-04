import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Explicit opt-in: run only against an isolated acceptance runtime, never the default user instance.
const base = process.env.BOT_SCHEDULES_HTTP_URL;
if (!base || new URL(base).hostname !== '127.0.0.1' || new URL(base).port === '3210') throw new Error('Set BOT_SCHEDULES_HTTP_URL to an isolated loopback Bot instance');
const call = async (path: string, method = 'GET', body?: unknown) => {
  const response = await fetch(base + path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(40000) });
  const data = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`); return data;
};
const nonce = randomUUID().slice(0,8), name = `定时验收-${nonce}`, token = `SCHEDULE_OK_${nonce}`;
const path = `/xbot-api/bots/${encodeURIComponent(name)}`, evidence: Record<string,unknown> = { name, startedAt: new Date().toISOString() };
await call('/xbot-api/bots', 'POST', { name, runtimeId: 'codex', timezone: 'Asia/Singapore', persona: '你是功能验收猫。收到验收任务只需回复指定标记，不调用任何工具，不读写文件。' });
const initial = await call(`${path}/routines`); assert.equal(initial.routines.length,0);
const repeatInput = { name: '周期启停验收', prompt: '验收专用，不执行实际工作', schedule: { kind: 'daily', time: '09:00', timezone: 'Asia/Singapore' }, idempotencyKey: randomUUID() };
const repeat = await call(`${path}/routines`,'POST',repeatInput);
try {
  const replay = await call(`${path}/routines`,'POST',repeatInput); assert.equal(replay.id,repeat.id);
  await call(`${path}/routines/${repeat.id}`,'PATCH',{enabled:false});
  const paused = (await call(`${path}/routines`)).routines.find((x:any)=>x.id===repeat.id);
  assert.equal(paused.status,'paused'); assert.equal(paused.registered,false);
  await call(`${path}/routines/${repeat.id}`,'PATCH',{enabled:true});
  const resumed = (await call(`${path}/routines`)).routines.find((x:any)=>x.id===repeat.id);
  assert.equal(resumed.status,'scheduled'); assert.equal(resumed.registered,true);
  evidence.repeat = { id: repeat.id, retrySameIdentity: true, paused: paused.status, resumed: resumed.status };
} finally { await call(`${path}/routines/${repeat.id}`,'DELETE'); }
assert.equal((await call(`${path}/routines`)).routines.length,0);
const at = new Date(Date.now()+10000).toISOString();
const once = await call(`${path}/routines`,'POST',{ name: '定时执行验收', prompt: `定时任务验收。请只回复 ${token}，不调用工具，不读写文件。`, schedule:{kind:'once',at}, idempotencyKey:randomUUID() });
evidence.once = { id:once.id, at, threadId:once.threadId };
const deadline=Date.now()+180000;
let lastStatus: unknown;
while(Date.now()<deadline) {
  const task=(await call(`${path}/routines`)).routines.find((x:any)=>x.id===once.id);
  lastStatus=task;
  if (task?.status==='failed' || task?.status==='missed') throw new Error(`Scheduled wake failed: ${JSON.stringify(task)}`);
  const page=await call(`/native-api/api/messages?threadId=${encodeURIComponent(once.threadId)}&limit=200`);
  const reply=page.messages.find((m:any)=>m.type==='assistant' && m.catId && m.content?.includes(token) && !m.isDraft);
  if(task?.status==='delivered' && reply) {
    const history=await call(`${path}/routines/${once.id}/runs`);
    assert.equal(history.runs[0].outcome,'RUN_DELIVERED');
    evidence.once={ ...(evidence.once as object),status:task.status,enabled:task.enabled,registered:task.registered,run:history.runs[0],reply:{id:reply.id,catId:reply.catId,content:reply.content,timestamp:reply.timestamp} };
    evidence.finishedAt=new Date().toISOString();
    const dir=resolve('.runtime/schedules-acceptance');mkdirSync(dir,{recursive:true});writeFileSync(resolve(dir,'http-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
    console.log(JSON.stringify(evidence,null,2));process.exit(0);
  }
  await delay(2000);
}
throw new Error(`No verified scheduled Agent reply within 180s; latest schedule: ${JSON.stringify(lastStatus)}`);
