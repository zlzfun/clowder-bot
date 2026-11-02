import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export function auditChronologicalReplies(evidence, transcript) {
  const starts = Object.fromEntries(['PROGRESS_OK', 'B_ACCEPTED', 'DIRECTION_SENT', 'QUESTION_OK'].map((marker, i) => [marker, evidence.sends[i + 1].at]));
  for (const task of ['A', 'B']) starts[`${task}_DONE`] = JSON.parse(readFileSync(join(evidence.fixture, `${task}.done.json`), 'utf8')).finished * 1000;
  return Object.entries(starts).map(([marker, at]) => {
    const row = transcript.messages.find(m => m.role === 'assistant' && m.native?.origin === 'callback' && new Date(m.time).getTime() >= at && new RegExp(`^\\s*${marker}\\b`, 'm').test(m.content));
    assert.ok(row, `${marker} must have a new explicit native chat message after its trigger`);
    return { marker, messageId: row.native_message_id, createdAt: new Date(row.time).getTime(), delayMs: Math.round(new Date(row.time).getTime() - at) };
  });
}

// Independent native evidence, scoped to this synthetic chat's invocation.
// Heartbeats alone could be produced by the parent; they are insufficient.
export function auditBackgroundJourney(evidence, transcript, dataRoot) {
  const invocationIds = [...new Set(transcript.messages.filter(m => m.role === 'assistant')
    .map(m => m.native?.lifecycle?.invocationId ?? m.native?.extra?.turnExecution?.invocationId ?? m.native?.extra?.stream?.turnInvocationId).filter(Boolean))];
  assert.equal(invocationIds.length, 1, 'all input must stay in the same native parent invocation');
  const archiveRoot = join(dataRoot, 'internal/cli-raw-archive');
  const files = readdirSync(archiveRoot).map(day => join(archiveRoot, day, `${invocationIds[0]}.ndjson.gz`)).filter(existsSync);
  assert.equal(files.length, 1, 'exact native raw archive must exist');
  const rows = gunzipSync(readFileSync(files[0])).toString().trim().split('\n').map(JSON.parse);
  const sessions = [...new Set(rows.filter(r => !r.payload.parent_tool_use_id && r.payload.session_id).map(r => r.payload.session_id))];
  assert.equal(sessions.length, 1, 'the main native CLI session must not be replaced');
  const children = rows.filter(r => r.payload.type === 'system' && r.payload.subtype === 'task_started' && r.payload.task_type === 'local_agent');
  assert.equal(children.length, 2, 'two real subagents, no replacement or recursive coordinators');
  assert.ok(children.every(r => r.payload.is_backgrounded === true && r.payload.spawn_depth === 1));
  const a = children.find(r => r.payload.prompt?.includes('pulse.py A 210'))?.payload;
  const b = children.find(r => r.payload.prompt?.includes('pulse.py B 75'))?.payload;
  assert.ok(a && b && a.task_id !== b.task_id, 'A and B must have separate native child identities');
  const tools = rows.flatMap(r => r.payload.type === 'assistant' ? (r.payload.message?.content ?? [])
    .filter(c => c.type === 'tool_use').map(c => ({ ...c, at: r.timestamp, parent: r.payload.parent_tool_use_id })) : []);
  const steer = tools.find(t => t.name === 'SendMessage' && !t.parent &&
    (t.input.to === a.task_id || t.input.recipient === a.task_id) && JSON.stringify(t.input).includes('permissions'));
  assert.ok(steer, 'direction must be messaged to the original A child');
  const writesDirection = t => {
    const input = t.input ?? {};
    if (t.name === 'Write') return input.file_path?.endsWith('/A.direction') && input.content?.includes('permissions');
    const cmd = input.command ?? '';
    return t.name === 'Bash' && cmd.includes('A.direction') && cmd.includes('permissions') && /(write_text|write\(|>\s*[^\n]*A\.direction)/.test(cmd);
  };
  const directionWrites = tools.filter(writesDirection);
  assert.ok(directionWrites.some(t => t.parent === a.tool_use_id && t.at >= steer.at), 'the original child must apply the change');
  assert.equal(directionWrites.some(t => !t.parent), false, 'the parent must not impersonate child steering');
  assert.equal(tools.some(t => t.name === 'TaskStop'), false, 'followups must not stop existing tasks');
  const result = rows.findLast(r => r.payload.type === 'result')?.payload;
  assert.equal(result?.subagent_stats?.completed, 2);
  assert.equal(result?.subagent_stats?.failed, 0);
  assert.equal(Object.values(result?.subagent_stats?.killed ?? {}).reduce((a, b) => a + b, 0), 0);
  assert.ok(rows.some(r => r.payload.subtype === 'session_state_changed' && r.payload.state === 'idle'), 'native host must drain both reports before ending');
  const reports = {};
  for (const task of ['A', 'B']) {
    const done = JSON.parse(readFileSync(join(evidence.fixture, `${task}.done.json`), 'utf8'));
    assert.ok(evidence.sends.at(-1).at < done.finished * 1000, 'no further user input may trigger completion reporting');
    const report = rows.find(r => r.payload.type === 'assistant' && !r.payload.parent_tool_use_id &&
      r.timestamp >= done.finished * 1000 && (r.payload.message?.content ?? []).some(c =>
        (c.type === 'text' && new RegExp(`^\\s*${task}_DONE\\b`, 'm').test(c.text)) ||
        (c.type === 'tool_use' && c.name?.includes('cat_cafe_post_message') && new RegExp(`^\\s*${task}_DONE\\b`, 'm').test(c.input?.content ?? c.input?.text ?? ''))));
    assert.ok(report, `${task} must be reported by the parent after actual completion, without another user message`);
    reports[task] = { completedAt: done.finished * 1000, parentReportAt: report.timestamp, parentReportDelayMs: Math.round(report.timestamp - done.finished * 1000) };
  }
  return { invocationId: invocationIds[0], sessionId: sessions[0], archive: files[0], children: [a, b].map(c => ({ id: c.task_id, toolUseId: c.tool_use_id, background: c.is_backgrounded })), directionMessageAt: steer.at, reports, nativeStats: result.subagent_stats };
}
