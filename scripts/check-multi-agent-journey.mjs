import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

if (process.env.BOT_MULTI_AGENT_ACCEPTANCE !== '1') throw Error('Opt in with BOT_MULTI_AGENT_ACCEPTANCE=1; invokes three real local Agents.');
const port = Number(process.env.PORT || 3211);
if (port === 3210) throw Error('Use an isolated candidate, never the production Bot port.');
const id = process.env.BOT_MULTI_RESUME || randomUUID().slice(0, 8);
assert.match(id, /^[a-f0-9]{8}$/);
const base = `http://127.0.0.1:${port}`;
const artifacts = resolve('.runtime/multi-agent-acceptance', id);
const fixture = resolve(process.env.BOT_RUNTIME_DATA_DIR || '.runtime/task-control-data', 'workspace/.bot-validation', `multi-${id}`);
mkdirSync(artifacts, { recursive: true }); mkdirSync(fixture, { recursive: true });
const evidenceFile = join(artifacts, 'evidence.json');
const evidence = process.env.BOT_MULTI_RESUME ? JSON.parse(readFileSync(evidenceFile, 'utf8')) : { id, artifacts, fixture, startedAt: Date.now(), cats: {}, phases: {} };
const save = () => writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
const phaseFilter = process.env.BOT_MULTI_PHASE?.split(',');
const allPhases = ['profile-tree','claim-race','handoff','tree-stop'];
if (phaseFilter) assert.ok(phaseFilter.length && phaseFilter.every(name=>allPhases.includes(name)), 'Unknown acceptance phase');
evidence.selectedPhases = phaseFilter ?? allPhases;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function api(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  if (!response.ok) throw Error(`${method} ${path}: ${response.status} ${text}`);
  return response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
}
async function until(label, fn, timeout = 360000) {
  const start = Date.now(); let logged = start;
  while (Date.now() - start < timeout) {
    const value = await fn(); if (value) return value;
    if (Date.now() - logged > 30000) { console.log(JSON.stringify({ waiting: label, seconds: Math.round((Date.now() - start) / 1000) })); logged = Date.now(); }
    await delay(1500);
  }
  throw Error(`Timeout: ${label}`);
}
const tasks = async thread => (await api(`/native-api/api/tasks?threadId=${encodeURIComponent(thread)}`)).tasks;
const messages = async thread => (await api(`/native-api/api/messages?threadId=${encodeURIComponent(thread)}&limit=200`)).messages;
const terminal = task => ['completed', 'failed', 'stopped'].includes(task?.backgroundExecution?.state);
const tickFile = name => join(fixture, `${name}.jsonl`);
const ticks = name => existsSync(tickFile(name)) ? readFileSync(tickFile(name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const done = name => existsSync(join(fixture, `${name}.done`));
const cat = role => evidence.cats[role];
const mention = role => `@${cat(role).name}`;
const byTitle = (list, title) => {
  const matches=list.filter(t=>t.title===title||t.title.startsWith(`${title} `));
  assert.ok(matches.length<=1,`Ambiguous Task label ${title}; never guess between native IDs`);
  return matches[0];
};
const promptRules = '这是隔离真实协作验收。只操作指定目录，不修改验收脚本。持续工作必须由原生 Task 绑定的后台 Agent 执行，description="[task:ID] 简述"、run_in_background=true；子执行内 Bash 必须前台。主 Agent 负责原生 Task/A2A/结果报告，不代跑工作，不轮询等待子代理。完成回报通过原生 post_message；引用其他猫但不交给它时不要在行首@，避免额外派发。';
const actionHelp = '跨猫派发必须通过原生 post_message，clientMessageId使用唯一UUID，targetCats只有接手者ID，action={subjectRef:"subject:task:原生TaskID",actionFamily:"implement",successorSlot:"implementer",mode:"single",terminalPredicate:{kind:"task_done"},expectedOwnerRevision:最新revision}。报告结果回给原负责人用targetCats、不加action，不新建任务。';
const pulse = (name, seconds) => `python3 ${fixture}/pulse.py ${name} ${seconds}`;
async function send(thread, roles, text) {
  const body = { text: roles.map(mention).join('\n') + '\n' + text, idempotencyKey: randomUUID() };
  const result = await api(`/xbot-api/groups/${encodeURIComponent(thread)}/messages`, 'POST', body);
  return { at: Date.now(), body, receipt: result };
}
async function createTask(threadId, title, role) { return api('/native-api/api/tasks', 'POST', { threadId, title, why: `multi-agent acceptance ${id}`, createdBy: 'user', ...(role ? { ownerCatId: cat(role).id } : {}) }); }
async function control(task, action) { return api(`/native-api/api/tasks/${task.id}/background-control`, 'POST', { action, expectedOwnerRevision: task.ownerRevision ?? 0, expectedAttemptId: task.backgroundExecution?.attemptId ?? null }); }
async function snapshot(phase) {
  phase.tasks = await tasks(phase.threadId); phase.messages = await messages(phase.threadId);
  phase.queue = await api(`/native-api/api/threads/${phase.threadId}/queue`);
  phase.sessions = await api(`/native-api/api/threads/${phase.threadId}/sessions`);
  save();
}
async function newPhase(name, run) {
  if (phaseFilter && !phaseFilter.includes(name)) return;
  if (evidence.phases[name]?.passed) return;
  let phase = evidence.phases[name];
  if (phase?.threadId) throw Error(`Phase ${name} already started. Inspect its evidence; retry that phase in a fresh run (without BOT_MULTI_RESUME) to preserve artifacts and avoid reusing timers.`);
  if (phase) { evidence.previousAttempts ??= []; evidence.previousAttempts.push({ name, ...phase }); }
  const group = await api('/xbot-api/groups', 'POST', { name: `多猫-${id}-${name}-${randomUUID().slice(0, 4)}`, members: Object.values(evidence.cats).map(c => c.name) });
  phase = evidence.phases[name] = { threadId: group.id, startedAt: Date.now(), checks: [] }; save();
  console.log(JSON.stringify({ phase: name, threadId: group.id }));
  try { await run(phase); await snapshot(phase); phase.passed = true; phase.finishedAt = Date.now(); save(); console.log(JSON.stringify({ phase: name, passed: true, checks: phase.checks })); }
  catch (error) { phase.error = error.message; await snapshot(phase).catch(() => {}); save(); throw error; }
}

if (!process.env.BOT_MULTI_RESUME) {
  writeFileSync(join(fixture, 'sales.csv'), 'region,amount\neast,120\nwest,80\neast,-20\nwest,45\nnorth,75\n');
  writeFileSync(join(fixture, 'pulse.py'), `import json,os,pathlib,sys,time\np=pathlib.Path(__file__).resolve().parent\nname,seconds=sys.argv[1],int(sys.argv[2]); start=time.time()\nwith (p/(name+'.jsonl')).open('a',buffering=1) as log:\n while time.time()-start<seconds:\n  log.write(json.dumps(dict(pid=os.getpid(),at=time.time(),name=name))+'\\n'); time.sleep(1)\n(p/(name+'.done')).write_text('completed')\n`);
  writeFileSync(join(fixture, 'sales.py'), `import csv,json,pathlib,sys,time\np=pathlib.Path(__file__).resolve().parent\nrows=list(csv.DictReader((p/'sales.csv').open())); values={}\nfor row in rows: values[row['region']]=values.get(row['region'],0)+int(row['amount'])\nresult=dict(total=sum(values.values()),regions=values,rows=len(rows))\ntime.sleep(15)\nif sys.argv[1]=='verify':\n assert json.loads((p/'analysis.json').read_text())==result\n result['verified']=True\n(p/('analysis.json' if sys.argv[1]=='analyze' else 'verified.json')).write_text(json.dumps(result))\nprint(json.dumps(result))\n`);
  writeFileSync(join(fixture, 'race.py'), `import json,os,pathlib,sys,time\np=pathlib.Path(__file__).resolve().parent\nwith (p/'race-winner.json').open('x') as out: json.dump(dict(cat=sys.argv[1],pid=os.getpid()),out)\ntime.sleep(15)\n(p/'race.done').write_text('completed')\n`);
  evidence.fixtureHashes = Object.fromEntries(['sales.csv','sales.py','pulse.py','race.py'].map(name => [name, createHash('sha256').update(readFileSync(join(fixture, name))).digest('hex')])); save();
}
await api('/api/health');
const lock = JSON.parse(readFileSync(resolve('upstream.lock.json'), 'utf8'));
evidence.buildFingerprint = readFileSync(resolve(lock.build, '.bot-build-complete'), 'utf8').trim();
evidence.neutralNames = process.env.BOT_MULTI_NEUTRAL_NAMES === '1'; save();
const roles = {
  A: ['统筹', '协调需求、拆解任务和汇总报告；数据核算应交给画像最匹配的同伴；保持对话响应。'],
  B: ['数据', 'CSV销售数据分析专家，擅长数值汇总、退款抵扣、按地区统计；优先承担销售分析任务，并请审阅同伴独立复核。'],
  C: ['审阅', '独立结果核验专家，擅长核对原始CSV与分析结果、验证交付证据；也能执行明确授权的通用计时任务。'],
};
for (const [role, [label, description]] of Object.entries(roles)) if (!cat(role)) {
  const name = `${process.env.BOT_MULTI_NEUTRAL_NAMES === '1' ? { A: '成员甲', B: '成员乙', C: '成员丙' }[role] : label}-${id}`;
  const created = await api('/xbot-api/bots', 'POST', { name, runtimeId: 'claude', description, persona: `${description}\n${promptRules}\n只操作目录 ${fixture}。每个任务的后续工作由当前负责人推进；明确结果应通知委派者，但不要重复礼貌往返。` });
  evidence.cats[role] = { id: created.native_id, name, description }; save();
}
console.log(JSON.stringify({ id, artifacts, cats: evidence.cats }));

await newPhase('profile-tree', async p => {
  p.prompt = await send(p.threadId, ['A'], `${promptRules}\n${actionHelp}\n请完成销售核对报告。先读取原生成员画像，根据能力选择本群最适合CSV分析的成员（不要自己分析）。你创建自己的根Task标题 REPORT，保持负责汇总；为所选成员创建独立子Task标题 ANALYZE，parentTaskId指向REPORT、ownerCatId指向所选成员，再结构化派发。分析成员用后台Agent执行 python3 ${fixture}/sales.py analyze，产物analysis.json；完成后保持ANALYZE未done，创建复核子Task标题 VERIFY，parentTaskId指向ANALYZE，按画像交给独立审阅成员（ID ${cat('C').id}）。复核成员用后台Agent执行 python3 ${fixture}/sales.py verify，完成后标VERIFY done，并向数据成员报告 VERIFIED ${id}。数据成员读取核验结果、标ANALYZE done，通知你 ANALYSIS_ACCEPTED ${id}。你收到后核验原生Task与两个JSON，将REPORT标done，通过post_message给用户最终报告 REPORT_DONE ${id}，说明总额和各地区结果。每次派发必须传递上述目标、路径、原生父子TaskID和回报目标ID。等待时主会话自由回应，不启动等待型subagent，不poll文件。`); save();
  await until('profile chooses analyst and delegates verifier through three real owners', async () => {
    const list = await tasks(p.threadId); const a = byTitle(list,'REPORT'), b = byTitle(list,'ANALYZE'), c = byTitle(list,'VERIFY');
    if (!a || !b || !c) return false;
    assert.equal(a.ownerCatId,cat('A').id); assert.equal(b.ownerCatId,cat('B').id); assert.equal(c.ownerCatId,cat('C').id);
    assert.equal(b.delegatedFromTaskId,a.id); assert.equal(c.delegatedFromTaskId,b.id);
    return [a,b,c].every(t=>t.status==='done') && existsSync(join(fixture,'verified.json'));
  }, 600000);
  await until('three-level result returns to coordinator', async()=> (await messages(p.threadId)).some(m=>m.catId===cat('A').id && m.content?.includes(`REPORT_DONE ${id}`)));
  assert.deepEqual(JSON.parse(readFileSync(join(fixture,'analysis.json'),'utf8')), {total:300,regions:{east:100,west:125,north:75},rows:5});
  assert.equal(JSON.parse(readFileSync(join(fixture,'verified.json'),'utf8')).verified,true);
  const list=await tasks(p.threadId); for(const name of ['ANALYZE','VERIFY']) assert.equal(byTitle(list,name).backgroundExecution.state,'completed');
  p.checks.push('profile-selected B; A→B→C native Task tree; two real background children; verified CSV result; completion returns C→B→A');
});

await newPhase('claim-race', async p => {
  const task = await createTask(p.threadId,'RACE'); p.initial=task; save();
  p.prompt = await send(p.threadId,['B','C'],`${promptRules}\n本次只竞争认领同一个原生Task ${task.id}（标题RACE），不创建其他任务。两位都各调用一次原生update_task(taskId,status=doing,expectedOwnerRevision=0)，即使读到已经被认领也要发起这一次条件写入以验证冲突。仅返回成功且owner是自己的那位可以启动一个绑定该Task的后台Agent，以前台Bash执行 python3 ${fixture}/race.py 自己的原生catId（timeout60000）。成功者完成后核验race.done并标Task done，post_message报告CLAIM_WIN ${id}；另一位在冲突后只post_message报告CLAIM_LOST ${id}，不执行脚本、不重新认领、不建任务。`); save();
  await until('one native claim wins and one live Agent reports the conflict',async()=>{const list=await tasks(p.threadId),m=await messages(p.threadId); return byTitle(list,'RACE')?.status==='done'&&m.some(x=>x.content?.includes(`CLAIM_WIN ${id}`))&&m.some(x=>x.content?.includes(`CLAIM_LOST ${id}`));});
  const current=(await tasks(p.threadId)).find(t=>t.id===task.id), winner=JSON.parse(readFileSync(join(fixture,'race-winner.json'),'utf8'));
  assert.equal(current.ownerRevision,1); assert.ok([cat('B').id,cat('C').id].includes(current.ownerCatId)); assert.equal(winner.cat,current.ownerCatId);
  assert.equal(current.backgroundExecution.state,'completed'); assert.equal((await tasks(p.threadId)).length,1);
  p.checks.push('two real candidates; one revision-1 owner; loser did not start work; one exclusive worker output');
});

await newPhase('handoff', async p => {
  const h=await createTask(p.threadId,'TRANSFER','A'), u=await createTask(p.threadId,'UNRELATED','C'); p.initial={h,u}; save();
  p.launchA=await send(p.threadId,['A'],`${promptRules}\n认领原生Task ${h.id}（TRANSFER），启动绑定它的后台Agent，仅执行 ${pulse('H_A',300)}，Bash timeout360000。开始后post_message报告 H_A_STARTED。稍后用户会要求交接，不提前停止、不完成此Task。`);
  p.launchU=await send(p.threadId,['C'],`${promptRules}\n认领原生Task ${u.id}（UNRELATED），启动绑定它的后台Agent，仅执行 ${pulse('H_U',300)}，Bash timeout360000。不要处理TRANSFER或响应其他猫的交接。等待验收器精确停止。`); save();
  p.before=await until('A and unrelated C have real running children',async()=>{const l=await tasks(p.threadId),a=l.find(t=>t.id===h.id),b=l.find(t=>t.id===u.id);return a?.backgroundExecution?.state==='running'&&b?.backgroundExecution?.state==='running'&&ticks('H_A').length>=3&&ticks('H_U').length>=3?{a,b}:false;}); save();
  p.transfer=await send(p.threadId,['A'],`${actionHelp}\n现在授权将同一个原生Task ${h.id}正式交接给 ${cat('B').name}（ID ${cat('B').id}），在action内设置stopPreviousExecution=true和当前expectedOwnerRevision，不能新建替代Task、不能取消整个会话。传递上下文令牌 CONTEXT_${id}、${fixture}/H_A.jsonl 是你的既有进度；B收到原生交接后用新后台Agent读取该文件并记下行数，将令牌和行数写入 ${fixture}/handoff-context.json，然后仅执行 ${pulse('H_B',70)}，Bash timeout120000。B完成核验后标同一个Task done并post_message报告 HANDOFF_DONE ${id}。你只报告提交与旧任务停止事实，不标该Task done，不继续执行它。`); save();
  const accepted=await until('B takes native ownership and starts a distinct child',async()=>{const t=(await tasks(p.threadId)).find(t=>t.id===h.id);return t.ownerCatId===cat('B').id&&t.backgroundExecution?.ownerRevision===t.ownerRevision&&['running','completed'].includes(t.backgroundExecution?.state)&&ticks('H_B').length>=2?t:false;},360000);
  p.accepted=accepted; const aCount=ticks('H_A').length,uCount=ticks('H_U').length;
  assert.equal(accepted.ownerRevision,p.before.a.ownerRevision+1); assert.notEqual(accepted.backgroundExecution.attemptId,p.before.a.backgroundExecution.attemptId);
  assert.notEqual(accepted.backgroundExecution.invocationId,p.before.a.backgroundExecution.invocationId);
  p.question=await send(p.threadId,['B'],'独立问题：7乘8等于多少？请及时post_message答复 HANDOFF_QUESTION 56，保持后台执行。'); save();
  await until('new owner responds while working',async()=> (await messages(p.threadId)).some(m=>m.catId===cat('B').id&&/HANDOFF_QUESTION[\s\S]{0,30}56/.test(m.content??'')),90000);
  p.responsive = { at: Date.now(), background: (await tasks(p.threadId)).find(t=>t.id===h.id).backgroundExecution, ticks: ticks('H_B').length }; save();
  assert.equal(p.responsive.background.state,'running'); assert.equal(done('H_B'),false);
  await until('B completes same Task',async()=>{const t=(await tasks(p.threadId)).find(t=>t.id===h.id);return t.status==='done'&&t.backgroundExecution?.state==='completed'&&done('H_B');},180000);
  assert.equal(ticks('H_A').length,aCount); assert.equal(done('H_A'),false); assert.ok(ticks('H_U').length>uCount);
  p.progressProof={oldTicksAtAcceptance:aCount,oldTicksAfterSuccess:ticks('H_A').length,oldCompleted:done('H_A'),unrelatedTicksAtAcceptance:uCount,unrelatedTicksAfterSuccess:ticks('H_U').length,newTicks:ticks('H_B').length};
  const context=JSON.parse(readFileSync(join(fixture,'handoff-context.json'),'utf8')); assert.ok(JSON.stringify(context).includes(`CONTEXT_${id}`));
  p.stopUnrelated=await control((await tasks(p.threadId)).find(t=>t.id===u.id),'stop');
  await until('unrelated acceptance worker stops after explicit cleanup',async()=>terminal((await tasks(p.threadId)).find(t=>t.id===u.id)),45000);
  p.checks.push('same Task owner revision advances once; exact old child stops; B gets context and runs new attempt; unrelated C continues; new owner handles a question');
});

await newPhase('tree-stop', async p => {
  p.prompt=await send(p.threadId,['A'],`${promptRules}\n${actionHelp}\n请构建持续执行的三级Task树并保持后台运行，等待用户停止。你创建并认领根Task TREE_A，后台Agent仅执行 ${pulse('TREE_A',300)}。你创建子Task TREE_B（owner=${cat('B').id}, parentTaskId=TREE_A的ID）并结构化派发给数据成员；B认领后自己的后台Agent仅执行 ${pulse('TREE_B',300)}，先用不带action的post_message targetCats向A报告已启动的进度（下一轮工作），再创建孙Task TREE_C（owner=${cat('C').id},parentTaskId=TREE_B的ID）并派给审阅成员；C认领后后台Agent执行 ${pulse('TREE_C',300)}。此外用户授权C创建完全独立的Task TREE_U（不填parentTaskId），在同一主invocation中用第二个后台Agent执行 ${pulse('TREE_U',100)}。所有Bash timeout360000；不得缩短计时。每层传递全部后续指令和TaskID。TREE_U完成后C核验并标它done，主动post_message报告 TREE_U_DONE ${id}。A/B/C树由验收器取消，任何停止都不得标树Task done，不影响TREE_U。`); save();
  p.before=await until('three owners and four real children are running',async()=>{const l=await tasks(p.threadId); const found=Object.fromEntries(['TREE_A','TREE_B','TREE_C','TREE_U'].map(n=>[n,byTitle(l,n)])); return Object.values(found).every(t=>t?.backgroundExecution?.state==='running')&&Object.keys(found).every(n=>ticks(n).length>=3)?found:false;},600000); save();
  const tree=p.before; assert.equal(tree.TREE_B.delegatedFromTaskId,tree.TREE_A.id); assert.equal(tree.TREE_C.delegatedFromTaskId,tree.TREE_B.id); assert.equal(tree.TREE_U.delegatedFromTaskId,undefined);
  for(const [n,r]of [['TREE_A','A'],['TREE_B','B'],['TREE_C','C'],['TREE_U','C']])assert.equal(tree[n].ownerCatId,cat(r).id);
  assert.equal(tree.TREE_C.backgroundExecution.invocationId,tree.TREE_U.backgroundExecution.invocationId);
  p.queueBeforeQuestion=await api(`/native-api/api/threads/${p.threadId}/queue`);
  p.futureEntry=p.queueBeforeQuestion.queue.find(entry=>entry.targetCats?.includes(cat('A').id)&&entry.authorIntentByTarget?.[cat('A').id]?.requested==='next_work');
  assert.ok(p.futureEntry,'An actual future A2A entry must precede the current-parent question');save();
  p.question=await send(p.threadId,['A'],'独立问题：9乘9等于多少？请post_message答复 TREE_QUESTION 81，不停止任何工作。'); save();
  await until('coordinator remains responsive during three-level work',async()=> (await messages(p.threadId)).some(m=>m.catId===cat('A').id&&/TREE_QUESTION[\s\S]{0,30}81/.test(m.content??'')),90000);
  p.responsive = { at: Date.now(), tasks: await tasks(p.threadId) };
  p.queueAfterQuestion=await api(`/native-api/api/threads/${p.threadId}/queue`);
  assert.ok(p.queueAfterQuestion.queue.some(entry=>entry.id===p.futureEntry.id&&entry.status==='queued'),'Future A2A work must remain queued while current guidance is delivered');save();
  for (const n of ['TREE_A','TREE_B','TREE_C','TREE_U']) assert.equal(byTitle(p.responsive.tasks,n).backgroundExecution.state,'running');
  p.cancel=await control((await tasks(p.threadId)).find(t=>t.id===tree.TREE_A.id),'cancel'); save();
  await until('root cancellation stops all linked descendants',async()=>{const l=await tasks(p.threadId);return ['TREE_A','TREE_B','TREE_C'].every(n=>terminal(l.find(t=>t.id===tree[n].id)));},60000);
  const counts=Object.fromEntries(['TREE_A','TREE_B','TREE_C','TREE_U'].map(n=>[n,ticks(n).length]));
  await until('unrelated child under same C host continues',()=>ticks('TREE_U').length>=counts.TREE_U+3,15000);
  for(const n of ['TREE_A','TREE_B','TREE_C']){assert.equal(ticks(n).length,counts[n]);assert.equal(done(n),false);}
  p.stopProof={atTerminal:counts,afterGrace:Object.fromEntries(['TREE_A','TREE_B','TREE_C','TREE_U'].map(n=>[n,ticks(n).length]))};save();
  await until('unrelated work completes and reports independently',async()=>{const l=await tasks(p.threadId);return byTitle(l,'TREE_U')?.status==='done'&&done('TREE_U')&&(await messages(p.threadId)).some(m=>m.catId===cat('C').id&&m.content?.includes(`TREE_U_DONE ${id}`));},180000);
  const final=await tasks(p.threadId);assert.ok(byTitle(final,'TREE_A').backgroundCancelledAt);for(const n of ['TREE_A','TREE_B','TREE_C'])assert.notEqual(byTitle(final,n).status,'done');
  p.checks.push('A→B→C each has its own main invocation and child; root cancel reaches three tasks; C unrelated sibling survives in same host and completes; main question answered');
});
for(const [name,hash]of Object.entries(evidence.fixtureHashes))assert.equal(createHash('sha256').update(readFileSync(join(fixture,name))).digest('hex'),hash,`fixture ${name} modified`);
evidence.passed=allPhases.every(name=>evidence.phases[name]?.passed);
evidence.selectedPhasesPassed=evidence.selectedPhases.every(name=>evidence.phases[name]?.passed);
evidence.finishedAt=Date.now();save();console.log(JSON.stringify({passed:evidence.selectedPhasesPassed,fullSuitePassed:evidence.passed,id,artifacts,phases:Object.keys(evidence.phases)}));
