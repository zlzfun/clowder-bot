import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
if (process.env.BOT_TASK_HTTP_ACCEPTANCE !== '1') throw new Error('Opt in with BOT_TASK_HTTP_ACCEPTANCE=1; invokes a real local Agent.');
const port = Number(process.env.PORT || 3211);
if (port === 3210) throw new Error('Use a dedicated candidate instance for this acceptance.');
const base = `http://127.0.0.1:${port}`, id = process.env.BOT_TASK_HTTP_RESUME || randomUUID().slice(0, 8), name = `Task验收-${id}`;
const artifacts = resolve('.runtime/task-http-acceptance', id);
const fixture = resolve(process.env.BOT_RUNTIME_DATA_DIR || '.runtime/task-control-data', 'workspace/.bot-validation', id);
mkdirSync(artifacts, { recursive: true }); mkdirSync(fixture, { recursive: true });
assert.match(id, /^[a-f0-9]{8}$/);
const evidence = process.env.BOT_TASK_HTTP_RESUME ? JSON.parse(readFileSync(join(artifacts, 'evidence.json'), 'utf8')) : { id, name, artifacts, fixture, startedAt: Date.now(), checks: [] };
delete evidence.error;
const save = () => writeFileSync(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2));
async function api(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const text = await response.text(); if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
}
async function until(label, fn, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 1500)); }
  throw new Error(`Timeout: ${label}`);
}
const ticks = name => existsSync(join(fixture, `${name}.jsonl`)) ? readFileSync(join(fixture, `${name}.jsonl`), 'utf8').trim().split('\n').filter(Boolean) : [];
const taskList = async () => (await api(`/native-api/api/tasks?threadId=${encodeURIComponent(evidence.threadId)}`)).tasks;
async function transcript() { const page = await api(`/xbot-api/bots/${encodeURIComponent(name)}/transcript`); writeFileSync(join(artifacts, 'transcript.json'), JSON.stringify(page, null, 2)); return page.messages; }
const send = text => api(`/xbot-api/bots/${encodeURIComponent(name)}/messages`, 'POST', { text, idempotencyKey: randomUUID() });
if (!process.env.BOT_TASK_HTTP_RESUME) writeFileSync(join(fixture, 'pulse.py'), `import json,os,pathlib,sys,time
p=pathlib.Path(__file__).resolve().parent
name,seconds=sys.argv[1],int(sys.argv[2]); start=time.time()
with (p/(name+'.jsonl')).open('a',buffering=1) as log:
    while time.time()-start<seconds:
        log.write(json.dumps(dict(pid=os.getpid(),at=time.time()))+'\\n'); time.sleep(1)
(p/(name+'.done')).write_text('completed')
`);
save(); console.log(JSON.stringify({ stage: 'starting', artifacts, name }));
try {
  await api('/api/health');
  if (!process.env.BOT_TASK_HTTP_RESUME) await api('/xbot-api/bots', 'POST', { name, runtimeId: 'claude', persona: '你是本机 Task 功能验收助手。仅操作用户指定隔离目录。任务正常结束后应主动报告，不得缩短验收计时或修改脚本。' });
  const bot = await api(`/xbot-api/bots/${encodeURIComponent(name)}`);
  evidence.catId = bot.native_id ?? bot.native?.cat?.id; evidence.threadId = bot.native?.thread?.id ?? bot.thread_id; save();
  if (!process.env.BOT_TASK_HTTP_RESUME) await send(`请并行执行两个持续任务：Task A 和 Task B。先用原生 create_task 分别建立标题为 Task A、Task B 的无负责人普通任务，然后由你通过 update_task(status=doing,expectedOwnerRevision) 原子认领。每个任务用一个后台 Agent，description 须为 [task:对应原生ID] 加工作说明，run_in_background=true。A 仅以前台 Bash (timeout 240000, run_in_background=false) 运行 python3 ${fixture}/pulse.py A 180；B 仅以前台 Bash (timeout 180000, run_in_background=false) 运行 python3 ${fixture}/pulse.py B 85。子代理不能创建其它后台命令。不得修改脚本、缩短计时或主会话代跑。启动后通过原生 post_message 报告 LAUNCHED。B.done 出现后才可主动报告 B_DONE，并核验后更新 B 原生 Task 为 done。验收器会精确停止 A，保留 B。`);
  const both = await until('two claimed native Tasks with real running children', async () => {
    const tasks = await taskList(); const a = tasks.find(t => t.title === 'Task A'), b = tasks.find(t => t.title === 'Task B');
    if (a?.backgroundExecution?.state === 'running' && b?.backgroundExecution?.state === 'running' && ticks('A').length >= 3 && ticks('B').length >= 3) return { a, b };
  });
  evidence.initial = both; save();
  assert.equal(both.a.ownerCatId, evidence.catId); assert.equal(both.b.ownerCatId, evidence.catId);
  assert.equal(both.a.ownerRevision, 1); assert.equal(both.b.ownerRevision, 1);
  evidence.stop = await api(`/native-api/api/tasks/${both.a.id}/background-control`, 'POST', { action: 'stop', expectedOwnerRevision: both.a.ownerRevision, expectedAttemptId: both.a.backgroundExecution.attemptId });
  await until('A stopped receipt', async () => (await taskList()).find(t => t.id === both.a.id)?.backgroundExecution?.state === 'stopped', 45000);
  const stoppedTicks = ticks('A').length, bTicks = ticks('B').length;
  await send('独立问题：6乘7等于多少？请用 post_message 及时答复 QUESTION_OK 42，保持 B 运行。');
  await until('primary replied before B completes', async () => (await transcript()).some(m => m.role === 'assistant' && /QUESTION_OK[\s\S]{0,40}42/.test(m.content ?? '')), 60000);
  assert.equal(existsSync(join(fixture, 'B.done')), false);
  assert.equal(ticks('A').length, stoppedTicks); assert.ok(ticks('B').length > bTicks);
  evidence.checks.push('automatic native claim; two bound children; scoped stop; main reply while B runs'); save(); console.log('Scoped stop and main reply passed');
  await until('B real completion', () => existsSync(join(fixture, 'B.done')), 150000);
  await until('B proactive report and native business completion', async () => {
    const messages = await transcript(), tasks = await taskList();
    return messages.some(m => m.role === 'assistant' && /B_DONE/.test(m.content ?? '')) && tasks.find(t => t.id === both.b.id)?.status === 'done';
  }, 90000);
  evidence.finalTasks = await taskList(); evidence.passed = true; evidence.finishedAt = Date.now(); save();
  console.log(JSON.stringify({ passed: true, artifacts, checks: evidence.checks }));
} catch (error) { evidence.error = error.message; await transcript().catch(() => {}); evidence.finalTasks = await taskList().catch(() => []); save(); throw error; }
