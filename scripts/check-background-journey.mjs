import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { auditBackgroundJourney, auditChronologicalReplies } from './background-journey-evidence.mjs';

// Opt-in real-model acceptance. Uses the same HTTP ingress as the original chat.
// Retains its own Bot, transcript and evidence; never deletes user data.
if (process.env.BOT_BACKGROUND_SMOKE !== '1') throw new Error('Set BOT_BACKGROUND_SMOKE=1 to run the real-model journey.');
const base = `http://127.0.0.1:${process.env.PORT || 3210}`;
const id = process.env.BOT_BACKGROUND_RESUME || randomUUID().slice(0, 8), name = `后台旅程验收-${id}`;
assert.match(id, /^[a-f0-9]{8}$/, 'resume must name one isolated acceptance run');
const artifacts = resolve('.runtime/background-journey', id);
const workspace = resolve(process.env.BOT_RUNTIME_DATA_DIR || 'data/native', 'workspace');
const fixture = join(workspace, '.bot-validation', id);
mkdirSync(artifacts, { recursive: true }); mkdirSync(fixture, { recursive: true });
const evidence = process.env.BOT_BACKGROUND_RESUME
  ? JSON.parse(readFileSync(join(artifacts, 'evidence.json'), 'utf8'))
  : { id, name, fixture, startedAt: new Date().toISOString(), checks: [], sends: [] };
delete evidence.error; delete evidence.passed;
const save = () => writeFileSync(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2));
async function api(path, method = 'GET', body) {
  const res = await fetch(base + path, { method, headers: { Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return res.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
}
async function until(label, fn, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 1500)); }
  throw new Error(`Timeout: ${label}`);
}
function ticks(task) {
  const file = join(fixture, `${task}.jsonl`);
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
}
async function transcript() {
  const page = await api(`/xbot-api/bots/${encodeURIComponent(name)}/transcript`);
  writeFileSync(join(artifacts, 'transcript.json'), JSON.stringify(page, null, 2));
  return page.messages.filter(m => m.role === 'assistant');
}
async function send(text) {
  const previous = evidence.sends.find(s => s.text === text);
  if (previous?.receipt) return previous.at; // Resume observation without replaying accepted work.
  const attempt = previous ?? { at: Date.now(), text, idempotencyKey: randomUUID() };
  if (!previous) evidence.sends.push(attempt);
  save(); // Keep the same key even if the response is lost after native admission.
  attempt.receipt = await api(`/xbot-api/bots/${encodeURIComponent(name)}/messages`, 'POST', { text, idempotencyKey: attempt.idempotencyKey });
  save(); console.log(JSON.stringify({ sent: text, at: attempt.at }));
  return attempt.at;
}
async function replyAfter(marker, at, timeout = 60_000) {
  const pattern = marker === 'QUESTION_OK' ? /^\s*QUESTION_OK\b[\s\S]{0,100}?42/m : new RegExp(`^\\s*${marker}\\b[\\s\\S]{10,}`, 'm');
  const row = await until(marker, async () => (await transcript()).find(m => new Date(m.time).getTime() >= at && pattern.test(m.content ?? '')), timeout);
  const observedAt = Date.now(), ms = observedAt - at;
  evidence.checks.push({ reply: marker, observedAt, observedMs: ms, messageId: row.native_message_id }); save();
  console.log(JSON.stringify({ reply: marker, ms })); return row;
}
if (!process.env.BOT_BACKGROUND_RESUME) writeFileSync(join(fixture, 'pulse.py'), `import json, os, pathlib, sys, time
root = pathlib.Path(__file__).resolve().parent
task, seconds = sys.argv[1], int(sys.argv[2])
identity = str(os.getpid()) + '-' + str(time.time_ns())
start = time.time()
with (root / (task + '.jsonl')).open('a', buffering=1) as log:
    while time.time() - start < seconds:
        phase = (root / (task + '.direction')).read_text().strip() if (root / (task + '.direction')).exists() else 'initial'
        log.write(json.dumps(dict(task=task, identity=identity, at=time.time(), phase=phase)) + '\\n')
        time.sleep(1)
(root / (task + '.done.json')).write_text(json.dumps(dict(task=task, identity=identity, finished=time.time(), phase=phase)))
`);
save(); console.log(JSON.stringify({ artifacts, name, fixture }));
try {
  await until('dedicated runtime ready', async () => { try { return (await api('/api/health')).ok; } catch { return false; } }, 300_000);
  if (!process.env.BOT_BACKGROUND_RESUME) await api('/xbot-api/bots', 'POST', { name, runtimeId: process.env.BOT_BACKGROUND_RUNTIME || 'claude', persona: '你是帮助用户完成任务的助手。验收内容仅限用户指定的隔离目录，不访问无关文件或外部服务。' });
  const bot = await api(`/xbot-api/bots/${encodeURIComponent(name)}`);
  evidence.catId = bot.native_id ?? bot.native?.cat?.id; evidence.threadId = bot.native?.thread?.id ?? bot.thread_id; save();
  await send(`请执行长任务 A：运行 python3 ${fixture}/pulse.py A 210，完成后读取 A.done.json 和 A.jsonl，报告持续时间及采集条数。不要缩短计时或修改 pulse.py。过程中若我调整方向，请让负责 A 的执行者更新 ${fixture}/A.direction 文件；计时器会自行读取，不要重启它。必须等 A.done.json 出现才能报告完成，最终报告以 A_DONE 开头。请开始。`);
  await until('A actually running', () => ticks('A').length >= 3);
  const first = ticks('A')[0]; evidence.workerA = first; save();
  const progressAt = await send('现在任务 A 的进度如何？请读取实际记录，以 PROGRESS_OK 开头及时回复，原任务继续。');
  await replyAfter('PROGRESS_OK', progressAt);
  assert.equal(existsSync(join(fixture, 'A.done.json')), false, 'Progress must arrive before A completes');
  const bAt = await send(`再并行执行独立任务 B：运行 python3 ${fixture}/pulse.py B 75；不要缩短计时。等 B.done.json 出现后汇总采集条数，以 B_DONE 开头主动报告。A 继续执行。启动后请以 B_ACCEPTED 开头告知。`);
  await replyAfter('B_ACCEPTED', bAt);
  await until('B actually running', () => ticks('B').length >= 2, 60_000);
  assert.equal(existsSync(join(fixture, 'A.done.json')), false, 'A and B must overlap');
  const changedAt = await send(`调整 A 的方向：让原来负责 A 的 subagent 将 ${fixture}/A.direction 写为 permissions。不要由主会话代写；通过原生消息把指令送到原 subagent，不要取消或重启 A。以 DIRECTION_SENT 开头报告实际投递情况。`);
  await replyAfter('DIRECTION_SENT', changedAt);
  await until('A adopted changed direction', () => ticks('A').some(t => t.phase === 'permissions'), 60_000);
  evidence.checks.push({ directionAppliedMs: Math.round(ticks('A').find(t => t.phase === 'permissions').at * 1000 - changedAt) }); save();
  const questionAt = await send('顺便独立问一句：17 加 25 是多少？以 QUESTION_OK 开头回答，不等待任务结果。');
  await replyAfter('QUESTION_OK', questionAt);
  assert.equal(existsSync(join(fixture, 'A.done.json')), false, 'independent answer must not wait for A to finish');
  // No further user input: completion must come back on its own.
  await until('both worker timers finished', () => existsSync(join(fixture, 'A.done.json')) && existsSync(join(fixture, 'B.done.json')), 240_000);
  await replyAfter('A_DONE', JSON.parse(readFileSync(join(fixture, 'A.done.json'), 'utf8')).finished * 1000, 90_000);
  await replyAfter('B_DONE', JSON.parse(readFileSync(join(fixture, 'B.done.json'), 'utf8')).finished * 1000, 90_000);
  await until('native parent drained all reports', async () => {
    const current = await api(`/xbot-api/bots/${encodeURIComponent(name)}`);
    return current.native?.queue?.activeInvocations?.length === 0 && current.native?.queue?.queue?.length === 0;
  }, 90_000);
  await transcript();
  evidence.nativeEvidence = auditBackgroundJourney(evidence, JSON.parse(readFileSync(join(artifacts, 'transcript.json'), 'utf8')), resolve(process.env.BOT_RUNTIME_DATA_DIR || 'data/native'));
  evidence.chatEvidence = auditChronologicalReplies(evidence, JSON.parse(readFileSync(join(artifacts, 'transcript.json'), 'utf8')));
  const a = ticks('A'), b = ticks('B');
  assert.equal(new Set(a.map(t => t.identity)).size, 1, 'A was restarted');
  assert.equal(a[0].identity, first.identity);
  const maxGapSeconds = Math.max(...a.slice(1).map((t, i) => t.at - a[i].at));
  assert.ok(maxGapSeconds < 5, `A heartbeat paused: ${maxGapSeconds}s`);
  assert.ok(a.some(t => t.at >= b[0].at && t.at <= b.at(-1).at));
  evidence.checks.push({ continuousWorkerA: true, maxGapSeconds, aSamples: a.length, bSamples: b.length, finalDirection: a.at(-1).phase });
  evidence.passed = true;
} catch (error) {
  evidence.passed = false; evidence.error = String(error); process.exitCode = 1;
} finally {
  await transcript().catch(() => {}); evidence.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ passed: evidence.passed, error: evidence.error, artifacts }));
}
