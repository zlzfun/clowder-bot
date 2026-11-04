import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { root, lock } from './upstream-source.mjs';

const api = resolve(root, lock.build, 'packages/api');
const require = createRequire(join(api, 'package.json'));
const Database = require('better-sqlite3'), Fastify = require('fastify');
const load = name => import(pathToFileURL(join(api, 'dist', name)));
const { applyMigrations } = await load('domains/memory/schema.js');
const { DynamicTaskStore } = await load('infrastructure/scheduler/DynamicTaskStore.js');
const { RunLedger } = await load('infrastructure/scheduler/RunLedger.js');
const { GlobalControlStore } = await load('infrastructure/scheduler/GlobalControlStore.js');
const { ScheduleMutationProposalStore } = await load('infrastructure/scheduler/ScheduleMutationProposalStore.js');
const { TaskRunnerV2 } = await load('infrastructure/scheduler/TaskRunnerV2.js');
const { templateRegistry } = await load('infrastructure/scheduler/templates/registry.js');
const { scheduleRoutes } = await load('routes/schedule.js');
const { createDeliverFn } = await load('infrastructure/scheduler/delivery.js');
const { reminderTemplate } = await load('infrastructure/scheduler/templates/reminder.js');
const OWNER = 'bot-schedules-test-owner';
process.env.DEFAULT_OWNER_USER_ID = OWNER;
process.env.CAT_CAFE_BOT_SCHEDULES = '1';

async function setup(t, deliver = async () => 'admitted-message') {
  const dir = mkdtempSync(join(tmpdir(), 'bot-native-schedules-'));
  let state;
  const open = async () => {
    const db = new Database(join(dir, 'schedule.sqlite')); applyMigrations(db);
    const store = new DynamicTaskStore(db), ledger = new RunLedger(db), control = new GlobalControlStore(db);
    const audit = new ScheduleMutationProposalStore(db);
    const runner = new TaskRunnerV2({ logger: { info() {}, error() {} }, ledger, dynamicTaskStore: store, globalControlStore: control, deliver });
    runner.hydrateDynamic(store, templateRegistry);
    runner.start();
    const app = Fastify({ logger: false }); app.decorateRequest('sessionUserId', undefined);
    app.addHook('preHandler', async request => { if (request.headers['x-test-owner'] === 'yes') request.sessionUserId = OWNER; });
    await app.register(scheduleRoutes, { taskRunner: runner, dynamicTaskStore: store, templateRegistry, globalControlStore: control,
      ownerUserId: OWNER, scheduleMutationProposalStore: audit, approvalIngress: { async publish() { throw new Error('No agent approvals in owner tests'); } } });
    await app.ready();
    const call = (url, method = 'GET', payload, owner = true) => app.inject({ url, method,
      headers: owner ? { 'x-test-owner': 'yes' } : {}, ...(payload === undefined ? {} : { payload }) });
    state = { db, store, ledger, control, audit, runner, app, call };
    return state;
  };
  const close = async () => { state.runner.stop(); await state.app.close(); state.db.close(); };
  t.after(async () => { await close(); rmSync(dir, { recursive: true, force: true }); });
  await open();
  return { get current() { return state; }, restart: async () => { await close(); return open(); } };
}
const body = (trigger = { type: 'cron', expression: '0 9 * * *', timezone: 'Asia/Singapore' }) => ({
  templateId: 'reminder', trigger, params: { targetCatId: 'codex-sol', message: '检查构建' },
  display: { label: '构建检查', category: 'system', description: '检查构建' }, deliveryThreadId: 'thread-native-schedules', botIdempotencyKey: randomUUID(),
});
const created = async (s, input) => {
  const r = await s.call('/api/schedule/tasks', 'POST', input); assert.equal(r.statusCode, 200, r.body); return r.json().task.id;
};

test('native owner creation is idempotent across SQLite reopening, rejects drift and keeps audit/paused state', async t => {
  const h = await setup(t), input = body(); let s = h.current;
  assert.equal((await s.call('/api/schedule/tasks', 'POST', input, false)).statusCode, 401);
  const [a,b] = await Promise.all([created(s,input),created(s,input)]); assert.equal(a,b);
  assert.equal(s.store.getAll().length,1); assert.equal(s.audit.listAudit(OWNER).filter(x => x.action === 'create').length,1);
  const conflict = await s.call('/api/schedule/tasks','POST',{ ...input,params:{...input.params,message:'另一项工作'} });
  assert.equal(conflict.statusCode,409);
  const list = (await s.call('/api/schedule/tasks')).json(); assert.equal(list.botScheduleVersion,1);
  assert.equal(list.tasks[0].targetCatId,'codex-sol'); assert.equal(list.tasks[0].prompt,'检查构建');
  assert.equal(Object.hasOwn(list.tasks[0],'params'),false,'private/raw params are not projected');
  assert.equal((await s.call(`/api/schedule/tasks/${a}`,'PATCH',{enabled:false})).statusCode,200);
  s = await h.restart(); assert.equal(await created(s,input),a);
  assert.equal(s.store.getById(a).enabled,false); assert.equal(s.runner.getRegisteredTasks().includes(a),false);
  assert.equal((await s.call(`/api/schedule/tasks/${a}`,'PATCH',{enabled:true})).statusCode,200);
  s = await h.restart(); assert.equal(s.runner.getRegisteredTasks().includes(a),true);
  assert.equal((await s.call(`/api/schedule/tasks/${a}`,'DELETE')).statusCode,200);
  assert.equal(s.store.getById(a),null);
  assert.equal(s.audit.listAudit(OWNER).filter(x => x.action === 'create').length,1);
});

test('real native timer fires once into delivery, records attribution and survives restart without duplicate wake', async t => {
  const deliveries=[]; const h = await setup(t, async envelope => { deliveries.push(envelope); return 'admitted-message'; });
  let s=h.current;
  const id = await created(s,body({type:'once',fireAt:Date.now()+250}));
  const deadline=Date.now()+5000;
  while (!s.ledger.query(id,1).length && Date.now()<deadline) await delay(25);
  assert.equal(deliveries.length,1);
  assert.equal(deliveries[0].targetCatId,'codex-sol'); assert.equal(deliveries[0].threadId,'thread-native-schedules');
  assert.equal(deliveries[0].userId,OWNER); assert.equal(deliveries[0].sourceCategory,'scheduled');
  assert.equal(deliveries[0].privateContent, '[定时任务] 检查构建', 'the exact task must reach the target queue input, not only hidden public History');
  assert.equal(s.ledger.query(id,1)[0]?.outcome,'RUN_DELIVERED');
  assert.equal(s.store.getById(id).enabled,false);
  s=await h.restart(); await delay(75);
  assert.equal(deliveries.length,1);
  const record=(await s.call(`/api/schedule/tasks/${id}/runs?threadId=thread-native-schedules&limit=50`)).json();
  assert.equal(record.runs[0].outcome,'RUN_DELIVERED');
  const task=(await s.call('/api/schedule/tasks')).json().tasks.find(x=>x.id===id);
  assert.equal(task.registered,false); assert.equal(task.lastRun.outcome,'RUN_DELIVERED');
  assert.equal((await s.call(`/api/schedule/tasks/${id}`,'PATCH',{enabled:true})).statusCode,409);
});

test('offline one-shot is marked missed on hydration; effective state reflects global pause', async t => {
  let calls=0; const h=await setup(t,async()=>{calls++;return 'message';}); let s=h.current;
  const onceId=await created(s,body({type:'once',fireAt:Date.now()+100}));
  const cronId=await created(s,body());
  s.runner.stop();
  await delay(140); s=await h.restart();
  assert.equal(calls,0); assert.equal(s.ledger.query(onceId,1)[0]?.outcome,'SKIP_MISSED_WINDOW');
  assert.equal(s.store.getById(onceId).enabled,false);
  const missedHistory=(await s.call(`/api/schedule/tasks/${onceId}/runs?threadId=thread-native-schedules&limit=50`)).json();
  assert.equal(missedHistory.runs[0].outcome,'SKIP_MISSED_WINDOW');
  s.control.setGlobalEnabled(false,'test pause',OWNER);
  const task=(await s.call('/api/schedule/tasks')).json().tasks.find(x=>x.id===cronId);
  assert.equal(task.enabled,true); assert.equal(task.effectiveEnabled,false); assert.equal(task.registered,true);
});

test('HTTP readiness cannot report an unstarted scheduler as ready or accept a Bot creation', async t => {
  const h=await setup(t),s=h.current;
  const id=await created(s,body()); s.runner.stop();
  const list=(await s.call('/api/schedule/tasks')).json();
  assert.equal(list.botSchedulerReady,false);
  assert.equal(list.tasks.find(x=>x.id===id).effectiveEnabled,false);
  const response=await s.call('/api/schedule/tasks','POST',body());
  assert.equal(response.statusCode,503); assert.equal(s.store.getAll().length,1);
});

test('intervals wait on create/resume, pause durably, and check immediately on native restart', async t => {
  let calls=0; const h=await setup(t,async()=>{calls++;return 'admitted-message';}); let s=h.current;
  const id=await created(s,body({type:'interval',ms:300}));
  assert.equal(calls,0);
  const deadline=Date.now()+5000;
  while (!calls && Date.now()<deadline) await delay(20);
  assert.equal(calls,1);
  assert.equal((await s.call(`/api/schedule/tasks/${id}`,'PATCH',{enabled:false})).statusCode,200);
  await delay(350); assert.equal(calls,1);
  s=await h.restart(); await delay(50); assert.equal(calls,1);
  assert.equal((await s.call(`/api/schedule/tasks/${id}`,'PATCH',{enabled:true})).statusCode,200);
  assert.equal(calls,1);
  s=await h.restart();
  const restartedDeadline=Date.now()+1000;
  while (calls===1 && Date.now()<restartedDeadline) await delay(10);
  assert.equal(calls,2); assert.equal(s.ledger.query(id,10).filter(x=>x.outcome==='RUN_DELIVERED').length,2);
  await s.call(`/api/schedule/tasks/${id}`,'PATCH',{enabled:false});
});

test('failed native delivery is not reported as delivered and its error is readable', async t => {
  const h=await setup(t,async()=>{throw new Error('delivery-rejected-test');}),s=h.current;
  const id=await created(s,body({type:'once',fireAt:Date.now()+100}));
  const deadline=Date.now()+5000;
  while (!s.ledger.query(id,1).length && Date.now()<deadline) await delay(25);
  const run=s.ledger.query(id,1)[0]; assert.equal(run?.outcome,'RUN_FAILED'); assert.match(run.error_summary,/delivery-rejected-test/);
});

test('Bot reminders carry exact instructions through native atomic private input without changing ordinary reminders', async () => {
  const privateInputs=[], broadcasts=[], ordinary=[];
  const deliver=createDeliverFn({
    messageStore:{append(){throw new Error('must not append before admission');}},
    socketManager:{broadcastToRoom(...args){broadcasts.push(args);},emitToUser(){}},
    persistedQueueDelivery:{
      async deliverVisibleWithPrivateInput(input){privateInputs.push(input);return {admitted:true,notice:{...input.notice,id:'notice-1'}};},
      async deliver(input){ordinary.push(input);return {state:'admitted',message:{id:'ordinary-1'}};},
    },
  });
  const params={trigger:{type:'once',fireAt:Date.now()+1000},deliveryThreadId:'thread-exact',params:{message:'只回复 EXACT_INPUT',targetCatId:'codex-sol',triggerUserId:OWNER}};
  const run=async id=>reminderTemplate.createSpec(id,params).run.execute('ignored','thread-thread-exact',{deliver,occurrenceId:'occurrence-1'});
  await run('dyn-bot-exact');
  assert.equal(privateInputs.length,1); assert.equal(ordinary.length,0);
  const input=privateInputs[0];
  assert.equal(input.content,'[定时任务] 只回复 EXACT_INPUT'); assert.equal(input.notice.content,input.content);
  assert.equal(input.targetCatId,'codex-sol'); assert.equal(input.ownerUserId,OWNER);
  assert.deepEqual(input.from,{kind:'system',service:'scheduler'});
  assert.equal(broadcasts.length,1);
  await run('dyn-ordinary'); assert.equal(ordinary.length,1); assert.equal(privateInputs.length,1);
  process.env.CAT_CAFE_BOT_SCHEDULES='0';
  try {await run('dyn-bot-disabled');assert.equal(ordinary.length,2);assert.equal(privateInputs.length,1);}
  finally {process.env.CAT_CAFE_BOT_SCHEDULES='1';}
});
