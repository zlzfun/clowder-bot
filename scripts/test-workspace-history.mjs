import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const root=resolve(import.meta.dirname,'..');
const lock=JSON.parse(readFileSync(resolve(root,'upstream.lock.json'),'utf8'));
const runtime=resolve(root,lock.build),native=path=>import(pathToFileURL(resolve(runtime,'packages/api/dist',path)).href);
const {mutateOrdinaryTask,ordinaryTaskExpectation}=await native('domains/cats/services/stores/ports/OrdinaryTaskMutation.js');
const {serializeTask,hydrateTask}=await native('domains/cats/services/stores/redis/RedisTaskCodec.js');
const {TaskStore}=await native('domains/cats/services/stores/ports/TaskStore.js');
process.env.CAT_CAFE_BOT_TASK_HISTORY='1';
const seed=()=>({id:'task',kind:'work',threadId:'thread',subjectKey:null,title:'report',ownerCatId:'opus',ownerRevision:0,status:'todo',why:'',createdBy:'user',userId:'owner',createdAt:1,updatedAt:1});
const assignment=(task,to='sonnet',ref='message:handoff')=>({kind:'human_update',taskId:task.id,userId:'owner',expected:ordinaryTaskExpectation(task),input:{ownerCatId:to},messageRef:ref});

test('native ownership and its receipt change together; retries and stale writers cannot add history',()=>{
  const before=seed(),command=assignment(before);const result=mutateOrdinaryTask(before,command,100);
  assert.equal(result.kind,'updated');assert.equal(result.task.ownerCatId,'sonnet');
  assert.deepEqual(result.task.assignmentHistory,[{revision:1,fromCatId:'opus',toCatId:'sonnet',at:100,sourceMessageRef:'message:handoff',kind:'human_update'}]);
  const replay=mutateOrdinaryTask(result.task,command,200);assert.equal(replay.kind,'replayed');assert.equal(replay.task.assignmentHistory.length,1);
  const stale=mutateOrdinaryTask(result.task,assignment(before,'codex','message:other'),200);assert.equal(stale.kind,'refused');assert.equal(stale.task.assignmentHistory.length,1);
  const back=mutateOrdinaryTask(result.task,assignment(result.task,'opus','message:return'),300);assert.equal(back.task.assignmentHistory.length,2);assert.equal(back.task.assignmentHistory[1].revision,2);
  assert.equal(mutateOrdinaryTask(back.task,command,400).kind,'refused','ABA cannot replay an old owner request');
});
test('active task reassignment and no-op status changes never invent a successful handoff',()=>{
  const task={...seed(),executionRef:{invocationId:'i',parentInvocationId:'p',catId:'opus',threadId:'thread',sourceMessageId:'source'}};
  const denied=mutateOrdinaryTask(task,assignment(task),100);assert.equal(denied.kind,'refused');assert.equal(denied.task.assignmentHistory,undefined);
  const change={...assignment(seed()),input:{status:'doing'}};const status=mutateOrdinaryTask(seed(),change,100);assert.equal(status.kind,'updated');assert.equal(status.task.assignmentHistory,undefined);
});
test('handoff and claim receipts record only the exact native source and survive Redis codec',()=>{
  const task=seed();const handoff=mutateOrdinaryTask(task,{kind:'handoff',taskId:task.id,expected:ordinaryTaskExpectation(task),ownerCatId:'sonnet',messageRef:'message:source'},50);
  assert.equal(handoff.kind,'updated');assert.equal(handoff.task.assignmentHistory[0].kind,'handoff');assert.deepEqual(hydrateTask(serializeTask(handoff.task)).assignmentHistory,handoff.task.assignmentHistory);
  const unclaimed={...seed(),ownerCatId:null};const claimed=mutateOrdinaryTask(unclaimed,{kind:'update',taskId:unclaimed.id,expected:ordinaryTaskExpectation(unclaimed),actor:{userId:'owner',catId:'opus',threadId:'thread',invocationId:'i'},input:{status:'doing'}},75);
  assert.equal(claimed.task.assignmentHistory[0].kind,'claim');assert.equal(claimed.task.assignmentHistory[0].sourceMessageRef,null);
  assert.throws(()=>hydrateTask({...serializeTask(handoff.task),assignmentHistory:'[{"revision":0}]'}),/Invalid assignment history/);
  assert.equal(hydrateTask(serializeTask(seed())).assignmentHistory,undefined,'old rows have no fabricated past receipts');
});
test('native in-memory store persists the history alongside the task aggregate',async()=>{
  const store=new TaskStore();const task=await store.create({userId:'owner',threadId:'thread',title:'report',why:'',createdBy:'user',ownerCatId:'opus'});
  const result=await store.mutateOrdinaryTask(assignment(task));assert.equal(result.kind,'updated');assert.deepEqual((await store.get(task.id)).assignmentHistory,result.task.assignmentHistory);
});
test('history extension is opt-in and preserves existing receipts while disabled',()=>{
  const first=mutateOrdinaryTask(seed(),assignment(seed()),100).task;
  delete process.env.CAT_CAFE_BOT_TASK_HISTORY;
  try {const next=mutateOrdinaryTask(first,assignment(first,'opus','message:return'),200);assert.equal(next.kind,'updated');assert.deepEqual(next.task.assignmentHistory,first.assignmentHistory);}
  finally {process.env.CAT_CAFE_BOT_TASK_HISTORY='1';}
});
test('real Redis concurrent assignments have one winner and survive a new store instance',{skip:!process.env.BOT_TASK_TEST_REDIS_URL},async t=>{
  const url=new URL(process.env.BOT_TASK_TEST_REDIS_URL);assert.equal(url.hostname,'127.0.0.1');
  const Redis=createRequire(resolve(runtime,'packages/api/package.json'))('ioredis');
  const redis=new Redis(url.href,{keyPrefix:`bot-workspace-history:${randomUUID()}:`});t.after(()=>redis.quit());
  const {RedisTaskStore}=await native('domains/cats/services/stores/redis/RedisTaskStore.js');const store=new RedisTaskStore(redis);
  const task=await store.create({userId:'owner',threadId:'thread',title:'report',why:'',createdBy:'user',ownerCatId:'opus'});
  const results=await Promise.all([store.mutateOrdinaryTask(assignment(task)),store.mutateOrdinaryTask(assignment(task,'codex','message:competing'))]);
  assert.equal(results.filter(r=>r.kind==='updated').length,1);
  const restored=await new RedisTaskStore(redis).get(task.id);assert.equal(restored.assignmentHistory.length,1);assert.equal(restored.assignmentHistory[0].toCatId,restored.ownerCatId);
});
