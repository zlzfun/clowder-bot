const $ = id => document.getElementById(id);
const enc = encodeURIComponent;
const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
async function api(path, method = 'GET', body) {
  const r = await fetch('/native-api' + path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  // The HTTP status lets a view tell an absent API (404) or a stale write (409) from other failures.
  const result = await r.json().catch(error => { if (r.ok) throw error; return {}; });
  if (!r.ok) throw Object.assign(new Error(result.error || '原生请求失败'), { status: r.status }); return result;
}
function fail(error) { $('error').textContent = error.message; $('error').hidden = false; }
function details(title, value) { const d = node('details'); d.append(node('summary', title), node('pre', JSON.stringify(value, null, 2))); return d; }
function button(title, action) {
  const b = node('button', title); b.type = 'button';
  b.onclick = async () => { b.disabled = true; $('error').hidden = true; try { await action(); } catch(e) { fail(e); } finally { b.disabled = false; } }; return b;
}
let activeThread, events, revision = 0, threadIndex = new Map();
async function interaction(id, target) {
  const { interaction: record } = await api('/api/runtime-interactions/' + enc(id));
  const req = record.request;
  const box = node('article', undefined, 'card'); box.append(node('h3', req.title), node('p', req.description || req.message || ''), node('span', record.status, 'badge'));
  target.append(box);
  if (record.status !== 'pending' || !record.cardRef) return;
  const respond = async response => {
    await api('/api/runtime-interactions/' + enc(id) + '/respond', 'POST', { cardRef: record.cardRef, expectedRevision: record.revision, operationId: crypto.randomUUID(), response });
    await refresh();
  };
  if (req.kind === 'question') {
    const readers = {};
    for (const question of req.questions) {
      const field = node('div', undefined, 'question'); field.append(node('h4', question.header), node('p', question.question));
      const inputs = [];
      for (const option of question.options || []) {
        const label = node('label', undefined, 'option'), input = node('input');
        input.type = question.multiSelect ? 'checkbox' : 'radio'; input.name = id + ':' + question.id; input.value = option.label;
        label.append(input, node('span', option.label + (option.description ? ' — ' + option.description : ''))); field.append(label); inputs.push(input);
      }
      const other = node('input'); other.type = question.isSecret ? 'password' : 'text'; other.placeholder = '输入回答';
      if (!question.options || question.isOther) field.append(other);
      readers[question.id] = () => { const selected = inputs.filter(i => i.checked).map(i => i.value); if (other.value) selected.push(other.value); if (!selected.length && !question.allowUnanswered) throw new Error('请回答：' + question.header); return selected; };
      box.append(field);
    }
    box.append(button('提交回答', () => respond({ kind: 'answers', answers: Object.fromEntries(Object.entries(readers).map(([id, read]) => [id, read()])) })));
  } else if (req.kind === 'approval' || req.kind === 'elicitation') {
    let content;
    if (req.mode === 'form') {
      const fields = {};
      for (const [key, spec] of Object.entries(req.requestedSchema.properties)) {
        const label = node('label', spec.title || key), input = spec.enum ? node('select') : node('input');
        if (spec.enum) spec.enum.forEach(v => { const opt = node('option', String(v)); opt.value = String(v); input.append(opt); });
        else input.type = spec.type === 'boolean' ? 'checkbox' : ['number','integer'].includes(spec.type) ? 'number' : 'text';
        label.append(input); box.append(label); fields[key] = { input, spec };
      }
      content = () => Object.fromEntries(Object.entries(fields).map(([key, { input, spec }]) => [key, spec.type === 'boolean' ? input.checked : ['number','integer'].includes(spec.type) ? Number(input.value) : input.value]));
    } else if (req.mode === 'url' && /^https?:\/\//.test(req.url)) {
      const a = node('a', '打开请求提供的页面'); a.href = req.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; box.append(a);
    }
    const actions = node('div', undefined, 'actions');
    for (const decision of req.decisions) actions.append(button(decision.label, () => respond({ kind: 'decision', decisionId: decision.id, ...(content && decision.outcome === 'accept' ? { content: content() } : {}) })));
    box.append(actions);
  } else box.append(node('p', '此交互需要原生会话卡片，目前保留为待处理状态。'));
  box.append(button('拒绝此请求', async () => { await api('/api/runtime-interactions/' + enc(id) + '/reject', 'POST', { cardRef: record.cardRef }); await refresh(); }));
}
async function approvals() {
  const pending = await api('/api/approval-hub/pending');
  $('approvals').replaceChildren();
  if (!pending.items.length) $('approvals').append(node('p', '当前没有待审批事项。会话中的提问会显示在下方。'));
  for (const item of pending.items) {
    if (item.sourceFeatureId === 'F306') { await interaction(item.proposalId, $('approvals')); continue; }
    const box = node('article', undefined, 'card'); box.append(node('h3', item.summary), node('p', item.sourceFeatureId + ' · ' + item.requesterCatId), details('查看审批详情', item.detail));
    const descriptor = pending.manifest.find(m => m.id === item.sourceFeatureId);
    const path = descriptor?.decisionEndpointBase;
    if (path) {
      const actions = node('div', undefined, 'actions');
      if (item.inlineApprovable && item.decisionMode !== 'claim-select') actions.append(button('批准', async () => { await api(path + '/' + enc(item.proposalId) + '/approve', 'POST', {}); await refresh(); }));
      actions.append(button('拒绝', async () => { await api(path + '/' + enc(item.proposalId) + '/reject', 'POST', {}); await refresh(); })); box.append(actions);
    }
    $('approvals').append(box);
  }
}
// Native Tasks load on their own (runtime-tasks.js): a backend without them
// (404) or a failed read changes only that block, never the rest of the view.
function tasks(id, current) {
  if (!window.ClowderTasks) { $('tasks').replaceChildren(node('p', '原生任务模块没有加载；其余面板照常显示。', 'muted')); return; }
  return window.ClowderTasks.load({ api, host: $('tasks'), threadId: id, thread: threadIndex.get(id), isCurrent: () => current === revision });
}
async function thread() {
  const id = $('threads').value, current = ++revision;
  if (!id) { $('tasks').replaceChildren(node('p', '选择会话后显示它的原生任务。', 'muted')); $('thread').replaceChildren(node('p', '还没有会话。创建 Bot 并打开聊天后，会话会出现在这里。')); return; }
  const taskView = tasks(id, current);
  const [queue, sessions, messages] = await Promise.all([api(`/api/threads/${enc(id)}/queue`), api(`/api/threads/${enc(id)}/sessions`), api(`/api/messages?threadId=${enc(id)}&limit=200`)]);
  if (current !== revision) return;
  const view = $('thread'); view.replaceChildren(node('p', `${queue.activeInvocations.length} 个执行中 · ${queue.queue.length} 个队列项`));
  for (const run of queue.activeInvocations) {
    const row = node('div', undefined, 'card'); row.append(node('strong', run.catId), details('执行详情', run), button('停止此成员', async () => { await api(`/api/threads/${enc(id)}/cancel/${enc(run.catId)}`, 'POST', {}); await thread(); })); view.append(row);
  }
  for (const entry of queue.queue) {
    const row = node('div', undefined, 'card'); row.append(node('p', `${entry.status} · ${(entry.targetCats || []).join('、')}`), details('队列详情', entry));
    if (entry.status === 'queued') row.append(button('撤回此队列项', async () => { await api(`/api/threads/${enc(id)}/queue/${enc(entry.id)}`, 'DELETE'); await thread(); })); view.append(row);
  }
  const ids = new Set(messages.messages.map(m => m.extra?.runtimeInteractionCard?.interactionId).filter(Boolean));
  for (const interactionId of ids) await interaction(interactionId, view);
  view.append(details('原生会话链与用量', sessions), details('最近消息与来源', messages));
  if (messages.hasMore && messages.messages.length) {
    let oldest = messages.messages[0];
    const older = button('加载更早记录', async () => {
      const cursor = `${oldest.timelineOrderAt ?? oldest.timestamp}:${oldest.id}`;
      const page = await api(`/api/messages?threadId=${enc(id)}&limit=200&before=${enc(cursor)}`);
      if (current !== revision) return;
      older.before(details('更早的原生记录', page));
      oldest = page.messages[0];
      if (!page.hasMore || !oldest) older.remove();
    });
    view.append(older);
  }
  const note = node('textarea'); note.placeholder = '添加当前会话的共享笔记（不是跨会话长期记忆）';
  view.append(note, button('保存会话笔记', async () => { if (!note.value.trim()) return; await api('/api/memory', 'POST', { threadId: id, key: 'note-' + crypto.randomUUID(), value: note.value, updatedBy: 'user' }); note.value = ''; }));
  if (activeThread !== id) {
    events?.close(); activeThread = id;
    events = new EventSource(`/xbot-api/runtime/threads/${enc(id)}/events`);
    // Do not replace a form while the user is answering it. Refresh is explicit.
    events.addEventListener('native', () => { $('connection').textContent = '原生状态有更新 · 点击刷新查看'; });
  }
  await taskView;
}
async function refresh() {
  $('error').hidden = true;
  const selected = $('threads').value;
  // Each native view reads and fails on its own; #error still reports the first failure.
  const [threads, runtimes, accounts, catalog] = await Promise.allSettled([api('/api/threads'), api('/api/cats/native-runtimes'), api('/api/accounts'), api('/api/memory/catalog')]);
  const view = (result, target, render) => { if (result.status === 'fulfilled') render(result.value); else target.replaceChildren(node('p', '没能读取：' + result.reason.message, 'muted')); };
  if (threads.status === 'fulfilled') {
    threadIndex = new Map(threads.value.threads.map(t => [t.id, t]));
    $('threads').replaceChildren(...threads.value.threads.map(t => { const option = node('option', t.title || t.id); option.value = t.id; return option; }));
    if ([...$('threads').options].some(o => o.value === selected)) $('threads').value = selected;
  }
  // Read-only: readiness is login/config evidence, not a running or reachable Agent.
  const ready = { configured: '已有登录或配置记录', login_required: '需要先登录', not_installed: '未检测到' };
  view(runtimes, $('runtimes'), value => $('runtimes').replaceChildren(...value.runtimes.map(r => node('p', `${r.label} · ${r.installed ? '已安装' : '未安装'} · ${ready[r.readiness?.status] || '未确认登录状态'}`))));
  view(accounts, $('accounts'), value => $('accounts').replaceChildren(...(value.providers.length ? value.providers.map(a => node('p', `${a.name} · ${a.clientId || '原生'} · ${a.authType}`)) : [node('p', '没有原生账号记录。', 'muted')])));
  view(catalog, $('memory'), value => $('memory').replaceChildren(details('原生记忆集合', value)));
  const views = await Promise.allSettled([approvals(), threads.status === 'fulfilled' || $('threads').value ? thread() : undefined]);
  const failed = [threads, runtimes, accounts, catalog, ...views].find(r => r.status === 'rejected');
  if (failed) throw failed.reason;
  $('connection').textContent = '已连接 Clowder AI';
}
$('refresh').onclick = () => refresh().catch(fail);
$('threads').onchange = () => thread().catch(fail);
$('memory-form').onsubmit = async e => { e.preventDefault(); try { const q = new FormData(e.currentTarget).get('query'); $('memory').replaceChildren(details('搜索结果', await api('/api/memory/search?q=' + enc(q)))); } catch(error) { fail(error); } };
refresh().catch(fail);
