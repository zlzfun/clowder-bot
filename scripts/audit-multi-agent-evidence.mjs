import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
const id = process.argv[2]; assert.match(id ?? '', /^[a-f0-9]{8}$/);
const directory = resolve('.runtime/multi-agent-acceptance', id);
const evidence = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8'));
const archiveRoot = resolve(process.env.BOT_RUNTIME_DATA_DIR || '.runtime/task-control-data', 'internal/cli-raw-archive');
const dates = readdirSync(archiveRoot).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name));
const result = { id, phases: {} };
for (const [name, phase] of Object.entries(evidence.phases)) {
  if (!phase.messages) continue;
  const ids = new Map();
  for (const message of phase.messages) {
    const invocation = message.extra?.turnExecution?.invocationId ?? message.extra?.stream?.turnInvocationId;
    if (invocation) ids.set(invocation, message.catId);
  }
  function collectBindings(value) {
    if (!value || typeof value !== 'object') return;
    if (value.backgroundExecution?.invocationId) ids.set(value.backgroundExecution.invocationId, value.executionRef?.catId ?? value.ownerCatId);
    for (const child of Object.values(value)) collectBindings(child);
  }
  collectBindings(phase);
  const runs = [];
  for (const [invocationId, catId] of ids) {
    const file = dates.map(date => join(archiveRoot, date, `${invocationId}.ndjson.gz`)).find(existsSync);
    if (!file) { runs.push({ invocationId, catId, archiveMissing: true }); continue; }
    const rows = gunzipSync(readFileSync(file)).toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const run = { invocationId, catId, archive: file, firstAt: rows[0]?.timestamp, lastAt: rows.at(-1)?.timestamp, models: [], calls: [], children: [], results: [], profileObserved: false };
    const interesting = new Set();
    const profileCalls = new Set();
    for (const row of rows) {
      const p = row.payload;
      if (p.type === 'system' && p.subtype === 'init' && p.model) run.models.push(p.model);
      if (p.type === 'system' && ['task_started','task_notification'].includes(p.subtype)) run.children.push({ at: row.timestamp, type: p.subtype, taskId: p.task_id, toolUseId: p.tool_use_id, sessionId: p.session_id, status: p.status });
      for (const block of p.message?.content ?? []) {
        if (typeof block !== 'object') continue;
        if (block.type === 'tool_use' && /(?:create_task|update_task|post_message|get_thread_cats|^Agent$)/.test(block.name)) {
          const input = block.input ?? {};
          interesting.add(block.id);
          if (/get_thread_cats$/.test(block.name)) profileCalls.add(block.id);
          run.calls.push({ at: row.timestamp, id: block.id, name: block.name, fromChild: Boolean(p.parent_tool_use_id),
            reportMarker: /post_message$/.test(block.name) ? /^(?:REPORT_DONE|VERIFIED|ANALYSIS_ACCEPTED|HANDOFF_DONE|TREE_U_DONE) [a-f0-9]{8}\b/.exec(input.content ?? '')?.[0] : undefined,
            input: Object.fromEntries(['taskId','status','expectedOwnerRevision','parentTaskId','ownerCatId','targetCats','action','description','run_in_background'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]])) });
        }
        if (block.type === 'tool_result') {
          const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          if (profileCalls.has(block.tool_use_id) && text?.includes('memberProfiles')) run.profileObserved = true;
          if (interesting.has(block.tool_use_id)) run.results.push({ at: row.timestamp, toolUseId: block.tool_use_id, isError: Boolean(block.is_error), assignmentConflict: Boolean(block.is_error) && /Callback failed \(409\)/.test(text ?? '') && /\b(?:task_)?assignment_changed\b/.test(text ?? '') });
        }
      }
    }
    run.models = [...new Set(run.models)]; runs.push(run);
  }
  result.phases[name] = { passed: phase.passed === true, runs };
  if (name === 'claim-race' && phase.passed) {
    const claims = runs.filter(r=>r.calls?.some(c=>/update_task/.test(c.name)&&c.input.status==='doing'&&c.input.expectedOwnerRevision===0));
    assert.equal(new Set(claims.map(r=>r.catId)).size,2,'Two real callers must attempt the conditional claim');
    assert.ok(Math.max(...claims.map(r=>r.firstAt)) < Math.min(...claims.map(r=>r.lastAt)), 'Claimants must overlap in real execution');
    assert.ok(claims.some(r=>r.results.some(x=>x.assignmentConflict)),'A real tool result must record the claim conflict');
    result.phases[name].simultaneousClaimVerified = true;
  }
  if (name === 'profile-tree' && phase.passed && evidence.neutralNames) {
    assert.ok(runs.some(r=>r.catId===evidence.cats.A.id&&r.profileObserved),'Coordinator must actually receive native memberProfiles');
    result.phases[name].nativeProfileObserved = true;
    for (const [role,marker] of [['C','VERIFIED'],['B','ANALYSIS_ACCEPTED'],['A','REPORT_DONE']]) {
      assert.ok(runs.some(r=>r.catId===evidence.cats[role].id&&r.calls?.some(c=>!c.fromChild&&c.reportMarker===`${marker} ${id}`&&r.results.some(x=>x.toolUseId===c.id&&!x.isError))), `Missing successful native completion report ${marker}`);
    }
    result.phases[name].threeLevelReportsVerified=true;
  }
  if (name === 'handoff' && phase.passed) {
    assert.ok(runs.some(r=>r.catId===evidence.cats.B.id&&r.calls?.some(c=>!c.fromChild&&c.reportMarker===`HANDOFF_DONE ${id}`&&r.results.some(x=>x.toolUseId===c.id&&!x.isError))), 'Successor must actually post its completion report');
    result.phases[name].successorCompletionReported=true;
  }
  if (name === 'tree-stop' && phase.passed) {
    assert.ok(runs.some(r=>r.catId===evidence.cats.C.id&&r.calls?.some(c=>!c.fromChild&&c.reportMarker===`TREE_U_DONE ${id}`&&r.results.some(x=>x.toolUseId===c.id&&!x.isError))), 'Independent sibling must actually post its completion report');
    result.phases[name].independentCompletionReported=true;
  }
  if (phase.passed) {
    const bindings = new Map();
    function collect(value) {
      if (!value || typeof value !== 'object') return;
      if (value.backgroundExecution?.sdkTaskId) bindings.set(value.backgroundExecution.attemptId,value.backgroundExecution);
      for (const child of Object.values(value)) collect(child);
    }
    collect(phase);
    for (const binding of bindings.values()) {
      const run = runs.find(r=>r.invocationId===binding.invocationId);
      assert.ok(run && !run.archiveMissing,`Missing real SDK archive for ${binding.attemptId}`);
      assert.ok(run.children.some(c=>c.type==='task_started'&&c.taskId===binding.sdkTaskId),`Missing native child-start evidence for ${binding.attemptId}`);
    }
    result.phases[name].verifiedChildStarts=bindings.size;
  }
}
writeFileSync(join(directory,'native-audit.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({id,phases:Object.fromEntries(Object.entries(result.phases).map(([name,p])=>[name,{runs:p.runs.length,missing:p.runs.filter(r=>r.archiveMissing).length,simultaneousClaimVerified:p.simultaneousClaimVerified,nativeProfileObserved:p.nativeProfileObserved}]))}));
