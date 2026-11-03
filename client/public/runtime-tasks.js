// Native Tasks on the runtime panel (runtime.html, under the conversation
// selector). A Task, its owner and its background child execution are Clowder
// AI facts read from /native-api/api/tasks; this file keeps no task engine,
// poller or scheduler, and later changes arrive through the panel's explicit
// refresh and its SSE notice. Ordinary progress (status) and the background
// execution are separate facts: a finished child is not a finished Task, and a
// Task without a background record is not idle. A background record left by an
// earlier owner revision or attempt is shown as the previous execution, never
// as the current one. stop and cancel leave a native stop marker until resume;
// resume only lifts that ban, it restarts nothing and undoes nothing. Every
// control is one native background-control request; the list is then re-read,
// and no Task control ever falls back to cancelling a thread or a member. A
// handoff is only a user message to the current owner: the owner shown is
// always the fetched Task's. No state is inferred from message text.
(() => {
  const enc = encodeURIComponent;
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const has = (map, key) => typeof key === 'string' && Object.hasOwn(map, key);
  // Native text on one line; it also keeps a title from splitting the handoff request.
  // \s covers the Unicode line and paragraph separators as well.
  const oneLine = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  function status(text) { const p = node('p', text, 'muted'); p.setAttribute('role', 'status'); return p; }
  function when(value) {
    if (value == null || value === '') return '';
    const date = new Date(typeof value === 'number' ? value : String(value));
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false });
  }

  const PROGRESS = { todo: '待办', doing: '进行中', blocked: '受阻', done: '已完成' };
  const progress = value => has(PROGRESS, value) ? PROGRESS[value] : '状态未知';

  // The background child execution. starting and stopping are requests the
  // native side accepted, not outcomes: they read 请求已提交, never 已停止.
  const RUN = { starting: '启动请求已提交', running: '运行中', stopping: '停止请求已提交', completed: '本次执行已完成', failed: '本次执行失败', stopped: '已停止', unknown: '状态未知' };
  const PAST = { ...RUN, completed: '已完成', failed: '失败' };
  const LIVE = ['starting', 'running', 'stopping'];
  const revisionOf = task => Number.isSafeInteger(task.ownerRevision) ? task.ownerRevision : 0;
  // A record from another owner revision, or from an attempt other than the
  // Task's current execution, is history: the previous run, not the current one.
  function historical(task) {
    const run = task && task.backgroundExecution;
    if (!run || typeof run !== 'object') return false;
    if (Number.isSafeInteger(run.ownerRevision) && run.ownerRevision !== revisionOf(task)) return true;
    const ref = task.executionRef;
    return !!ref && typeof ref === 'object' && ref.subexecutionId !== run.attemptId;
  }
  function background(task) {
    const run = task && task.backgroundExecution;
    if (!run || typeof run !== 'object') return { state: 'none', record: false, past: false, live: false, terminal: false, stopRequested: false, text: '没有记录', note: '没有后台执行记录，不代表空闲。' };
    const state = has(RUN, run.state) ? run.state : 'unknown', live = LIVE.includes(state), past = historical(task);
    const marked = run.stopRequestedAt != null || (!past && task.backgroundStopRequestedAt != null);
    const stopRequested = state === 'stopping' || (live && marked);
    return { state, record: true, past, live, terminal: !live && state !== 'unknown', stopRequested,
      text: stopRequested ? RUN.stopping : (past ? PAST : RUN)[state],
      note: !past && state === 'completed' ? '后台执行完成不等于任务完成，任务进度看上方的普通进度。' : '' };
  }

  // Ordinary work as the native side defines it; cancel and handoff apply only to it.
  const ordinary = task => task.kind === 'work' && task.subjectKey === null && task.entrustedWork == null;
  const cancelled = task => task.backgroundCancelledAt != null;
  // stop and cancel both leave this marker until resume. Older rows kept it only on the current record.
  const stopMarked = task => task.backgroundStopRequestedAt != null
    || (!!task.backgroundExecution && typeof task.backgroundExecution === 'object' && !historical(task) && task.backgroundExecution.stopRequestedAt != null);
  const canStop = task => { const run = background(task); return !run.past && run.live && !run.stopRequested; };
  const canCancel = task => ordinary(task) && task.status !== 'done' && !cancelled(task);
  const canResume = task => cancelled(task) || stopMarked(task);
  // Native lifts the ban only once the background record has ended (its GET reconciles first).
  const resumeWait = task => { const run = background(task); return run.record && !run.terminal; };
  const resumeLabel = task => cancelled(task) ? '恢复任务' : '允许继续';
  const ALLOWED = { stop: canStop, cancel: canCancel, resume: task => canResume(task) && !resumeWait(task) };

  // The revision and attempt this page observed; the native side answers 409 if either moved.
  function controlBody(task, action) {
    const run = task.backgroundExecution;
    return { action, expectedOwnerRevision: Number.isSafeInteger(task.ownerRevision) ? task.ownerRevision : 0,
      expectedAttemptId: run && typeof run === 'object' && typeof run.attemptId === 'string' ? run.attemptId : null };
  }

  function catName(id, cats) {
    const cat = Array.isArray(cats) ? cats.find(c => c && c.id === id) : null;
    return oneLine(cat && (cat.name || cat.displayName)) || String(id);
  }
  function handoffBlocked(task) {
    if (!task.ownerCatId) return '还没有负责成员，正在等待原生认领；认领后才能请求交接。';
    if (!ordinary(task)) return '这类任务不走原生 Task 交接。';
    if (task.status === 'done') return '任务已完成，不再交接。';
    return '';
  }
  // Members of the selected conversation who could take the Task over; never the current owner.
  function handoffTargets(task, thread, cats) {
    const ids = thread && Array.isArray(thread.preferredCats) ? thread.preferredCats : [];
    return [...new Set(ids)].filter(id => typeof id === 'string' && id && id !== task.ownerCatId && (!Array.isArray(cats) || cats.some(c => c && c.id === id)))
      .map(id => ({ id, name: catName(id, cats) }));
  }
  // A user request to the current owner, who performs the native Task-backed handoff.
  function handoffMessage(task, threadId, targetCatId, idempotencyKey) {
    const revision = Number.isSafeInteger(task.ownerRevision) ? task.ownerRevision : 0;
    return { threadId, mentions: [task.ownerCatId], messageDisposition: 'continue_current', idempotencyKey,
      content: `请将原生 Task ${task.id}（${oneLine(task.title)}，当前 owner revision ${revision}）正式交接给 @${targetCatId}。只收束此任务所属后台执行，保留其他任务；使用原生 Task-backed 交接，回报实际结果。` };
  }

  const reason = error => oneLine(error && error.message).replace(/[。.]+$/, '') || '原生请求失败';
  const chinese = text => /\p{Script=Han}/u.test(text);
  const UNAVAILABLE = '当前后端还没有开放原生 Task，任务列表暂不可用；会话、队列和其他面板照常显示。';
  const SUBMITTED = {
    stop: '停止请求已提交，实际状态以原生后台执行记录为准。',
    cancel: '撤销已记录：此任务和它所属的子任务在恢复前不会开始新的执行；这不代表已在进行的工作已经停止，以执行记录为准。',
    resume: '恢复请求已提交：这只解除禁止，不会自动重新开始执行，也不会撤回先前已经产生的外部影响。需要继续时，请在聊天中给负责成员发送继续的消息。',
  };
  const UNCONFIRMED = '停止请求已记录，部分执行尚未确认停止，请刷新查看。';
  const UNCONFIRMED_HERE = '停止请求已记录，这里的执行尚未确认停止，请刷新查看。';
  // unconfirmedTaskIds: the stop intent is stored, but its delivery to these executions is unproven.
  const outcome = (action, unconfirmed) => !unconfirmed.length || action === 'resume' ? SUBMITTED[action] : (action === 'cancel' ? '撤销已记录；' : '') + UNCONFIRMED;
  // Native error codes of background-control, in words; a Chinese reason is shown as it is.
  const CODES = {
    task_assignment_changed: '任务的负责成员或后台执行已经变化',
    task_execution_stop_unproven: '原生还没有确认当前执行已经停止，暂时不能恢复',
    background_control_unavailable: '当前状态不支持这个操作',
  };
  // 409: what this page saw is stale or the action does not apply; 404: no such route or Task.
  function refused(error) {
    const said = reason(error);
    if (error && error.status === 404) return `当前后端没有开放这个任务操作，或任务已不存在${chinese(said) ? `（${said}）` : ''}。已重新读取原生 Task。`;
    return `${chinese(said) ? said : has(CODES, said) ? CODES[said] : '任务已有变化，或当前状态不支持这个操作'}。已重新读取原生 Task，请核对后再操作。`;
  }
  function returned(reply, id) {
    const task = reply && typeof reply === 'object' && reply.task && typeof reply.task === 'object' ? reply.task : reply;
    return task && typeof task === 'object' && task.id === id ? task : null;
  }

  // The newest read of a host wins; an older read or another conversation never draws over it.
  const generations = new WeakMap(), shown = new WeakMap();
  const current = view => generations.get(view.host) === view.generation && (!view.isCurrent || view.isCurrent());
  const call = (view, path, method, body) => Promise.resolve().then(() => view.api(path, method, body));

  // ctx: { api, host, threadId, thread, isCurrent }. Never rejects: an absent
  // or failing Task API changes only this block. notice { taskId, text } is a
  // control's outcome; a failed re-read after it keeps what it already showed.
  async function load(ctx, notice) {
    const generation = (generations.get(ctx.host) || 0) + 1;
    generations.set(ctx.host, generation);
    const view = { api: ctx.api, host: ctx.host, threadId: ctx.threadId, thread: ctx.thread, isCurrent: ctx.isCurrent, generation, list: [], cats: null };
    const before = notice ? shown.get(ctx.host) : null;
    if (before) for (const card of before.cards) hold(card, true);
    else { shown.delete(ctx.host); ctx.host.replaceChildren(node('p', '正在读取原生任务…', 'muted')); }
    const keep = text => {
      if (!before) { shown.delete(ctx.host); ctx.host.replaceChildren(...(notice ? [status(notice.text)] : []), node('p', text, 'muted')); return; }
      generations.set(ctx.host, before.generation);
      for (const card of before.cards) hold(card, false);
      ctx.host.replaceChildren(node('p', text, 'muted'), ...before.nodes);
    };
    try {
      const [tasks, cats] = await Promise.allSettled([call(view, '/api/tasks?threadId=' + enc(view.threadId)), call(view, '/api/cats')]);
      if (!current(view)) return;
      const list = tasks.status === 'fulfilled' && tasks.value && Array.isArray(tasks.value.tasks) ? tasks.value.tasks.filter(t => t && typeof t === 'object') : null;
      if (!list) {
        const error = tasks.status === 'rejected' ? tasks.reason : null;
        keep(error && error.status === 404 ? UNAVAILABLE : error ? `没能读取原生 Task：${reason(error)}。其他面板不受影响，可稍后点「刷新状态」重试。` : '原生 Task 的返回格式无法识别。');
        return;
      }
      view.list = list;
      view.cats = cats.status === 'fulfilled' && cats.value && Array.isArray(cats.value.cats) ? cats.value.cats : null;
      render(view, notice);
    } catch (error) {
      if (current(view)) keep('原生任务没能显示：' + reason(error));
    }
  }

  function render(view, notice) {
    const unconfirmed = notice && Array.isArray(notice.unconfirmed) ? notice.unconfirmed : [];
    const note = task => !notice ? '' : notice.taskId === task.id ? notice.text : unconfirmed.includes(task.id) ? UNCONFIRMED_HERE : '';
    const cards = view.list.map(task => card(view, task, note(task)));
    const nodes = [node('p', view.list.length ? `${view.list.length} 个原生任务` : '这个会话还没有原生任务。', 'muted')];
    if (!view.cats) nodes.push(node('p', '成员名单暂时没能读取，负责成员先显示原生 ID。', 'muted'));
    if (notice && !view.list.some(task => task.id === notice.taskId)) nodes.push(status(notice.text));
    nodes.push(...cards.map(state => state.box));
    shown.set(view.host, { generation: view.generation, cards, nodes });
    view.host.replaceChildren(...nodes);
  }
  function card(view, task, text) {
    const state = { task, box: node('article', undefined, 'card'), pending: false, sent: false, key: '', keyTarget: '', buttons: [], pick: null, send: null, line: null };
    fill(view, state, text);
    return state;
  }

  // Draws one Task from its native record. Only the record decides the words and the controls.
  function fill(view, state, text) {
    const { task, box } = state, run = background(task), parts = [];
    Object.assign(state, { sent: false, buttons: [], pick: null, send: null, line: status(text) });
    box.setAttribute('data-task-id', String(task.id ?? ''));
    parts.push(node('h4', oneLine(task.title) || '（无标题）'));
    const owner = node('p', `负责成员：${task.ownerCatId ? catName(task.ownerCatId, view.cats) : '尚无，等待原生认领'} · 普通进度 `);
    owner.append(node('span', progress(task.status), 'badge'));
    const bg = run.record ? task.backgroundExecution : null, updated = bg ? when(bg.updatedAt) : '';
    const execution = node('p', '后台执行 ');
    execution.append(node('span', run.past ? '没有当前记录' : run.text, 'badge'));
    if (updated && !run.past) execution.append(`更新于 ${updated}`);
    parts.push(owner, execution);
    if (run.past) {
      parts.push(node('p', '没有当前后台执行记录，不代表空闲。', 'muted'));
      const previous = node('p', '上次后台执行 ', 'muted');
      previous.append(node('span', run.text, 'badge'));
      const whose = Number.isSafeInteger(bg.ownerRevision) && bg.ownerRevision !== revisionOf(task)
        ? `属于 owner revision ${bg.ownerRevision}（当前为 ${revisionOf(task)}）` : '属于另一次执行';
      previous.append(`${whose}，不是当前执行${updated ? ` · 更新于 ${updated}` : ''}`);
      parts.push(previous);
    } else if (run.note) parts.push(node('p', run.note, 'muted'));
    const summary = oneLine(bg && bg.summary);
    if (summary) parts.push(node('p', `${run.past ? '上次后台摘要' : '后台摘要'}：${summary}`, 'muted'));
    // A stop or cancel is an intent; only a current record that has ended proves the execution stopped.
    const unproven = run.record && !run.past && run.terminal ? '' : '这不代表已在进行的工作已经停止，以执行记录为准。';
    if (cancelled(task)) { const at = when(task.backgroundCancelledAt); parts.push(node('p', `已撤销${at ? `（${at}）` : ''}：恢复前不会开始新的执行。${unproven}`)); }
    else if (stopMarked(task)) {
      const at = when(task.backgroundStopRequestedAt != null ? task.backgroundStopRequestedAt : bg && bg.stopRequestedAt);
      parts.push(node('p', `已请求停止${at ? `（${at}）` : ''}：「允许继续」前不会开始新的执行。${unproven}`));
    }
    const origin = task.backgroundStopOwnerTaskId;
    if (canResume(task) && origin != null && origin !== '' && origin !== task.id) {
      const source = view.list.find(t => t.id === origin), title = source ? oneLine(source.title) : '';
      parts.push(node('p', `停止由 Task ${origin}${title ? `（${title}）` : ''}发起。`, 'muted'));
    }
    if (task.delegatedFromTaskId != null && task.delegatedFromTaskId !== '') {
      const parent = view.list.find(t => t.id === task.delegatedFromTaskId), title = parent ? oneLine(parent.title) : '';
      parts.push(node('p', `委派自 Task ${task.delegatedFromTaskId}${title ? `（${title}）` : ''}`, 'muted'));
    }
    if (oneLine(task.why)) parts.push(node('p', String(task.why), 'muted'));
    if (task.id != null && task.id !== '') {
      const controls = [];
      if (canStop(task)) controls.push(control(view, state, 'stop', '停止此次后台执行'));
      if (canCancel(task)) controls.push(control(view, state, 'cancel', '撤销整个任务'));
      if (canResume(task)) controls.push(control(view, state, 'resume', resumeLabel(task), resumeWait(task)));
      if (controls.length) { const row = node('div', undefined, 'actions'); row.append(...controls); parts.push(row); }
      if (canResume(task)) {
        if (resumeWait(task)) parts.push(node('p', '后台执行记录确认结束后才能恢复。', 'muted'));
        else if (task.executionRef && typeof task.executionRef === 'object' && !task.executionRef.subexecutionId) parts.push(node('p', '当前执行不是后台执行；原生确认这次执行结束后才能恢复。', 'muted'));
        parts.push(node('p', `「${resumeLabel(task)}」只解除禁止：不会自动重新开始执行，也不会撤回已经产生的外部影响。`, 'muted'));
      }
      parts.push(handoffRow(view, state));
    }
    const more = node('details');
    more.append(node('summary', '原生 ID 与记录'), node('p', `Task ID：${task.id ?? '（缺失）'}`), node('pre', JSON.stringify(task, null, 2)));
    parts.push(state.line, more);
    box.replaceChildren(...parts);
    hold(state, false);
  }
  function control(view, state, action, label, off = false) {
    const button = node('button', label); button.type = 'button';
    button.onclick = () => act(view, state, action);
    state.buttons.push({ button, off });
    return button;
  }
  // While one request is in flight every control of that Task is off, so a click is never sent twice.
  function hold(state, on) {
    state.pending = on;
    for (const { button, off } of state.buttons) button.disabled = on || off;
    if (state.pick) state.pick.disabled = on || state.sent;
    if (state.send) state.send.disabled = on || state.sent || !state.pick.value;
    state.box.setAttribute('aria-busy', String(on));
  }
  const say = (state, text) => { state.line.textContent = text; };

  async function act(view, state, action) {
    const task = state.task;
    if (state.pending || !current(view) || !ALLOWED[action](task)) return;
    hold(state, true);
    say(state, '正在提交…');
    let reply;
    try {
      reply = await call(view, `/api/tasks/${enc(task.id)}/background-control`, 'POST', controlBody(task, action));
    } catch (error) {
      if (!current(view)) return;
      hold(state, false);
      // Without a native answer the request may still have landed; nothing is claimed either way.
      if (!error || (error.status !== 409 && error.status !== 404)) { say(state, `没能确认请求结果：${reason(error)}。请以刷新后的原生状态为准。`); return; }
      say(state, refused(error));
      await load(view, { taskId: task.id, text: refused(error), unconfirmed: [] });
      return;
    }
    if (!current(view)) return;
    const next = returned(reply, task.id);
    const unconfirmed = reply && Array.isArray(reply.unconfirmedTaskIds) ? reply.unconfirmedTaskIds.filter(id => typeof id === 'string') : [];
    const text = outcome(action, unconfirmed);
    if (next) { state.task = next; fill(view, state, text); } else { hold(state, false); say(state, text); }
    // A control also reaches the Task's own descendants, so the whole list is re-read.
    await load(view, { taskId: task.id, text, unconfirmed });
  }

  function handoffRow(view, state) {
    const task = state.task, blocked = handoffBlocked(task), targets = blocked ? [] : handoffTargets(task, view.thread, view.cats);
    if (!targets.length) return node('p', blocked || '这个会话里没有其他可以接手的成员。', 'muted');
    const row = node('div', undefined, 'actions'), pick = node('select'), none = node('option', '选择接手成员…');
    pick.setAttribute('aria-label', '选择接手成员');
    none.value = '';
    pick.append(none, ...targets.map(target => { const option = node('option', target.name); option.value = target.id; return option; }));
    const send = node('button', '请求交接'); send.type = 'button';
    pick.onchange = () => { send.disabled = state.pending || state.sent || !pick.value; };
    send.onclick = () => handoff(view, state, targets);
    Object.assign(state, { pick, send });
    row.append(pick, send);
    return row;
  }
  async function handoff(view, state, targets) {
    const task = state.task, target = state.pick ? state.pick.value : '';
    if (state.pending || state.sent || !current(view) || !targets.some(t => t.id === target)) return;
    // Retrying the same request keeps its key, so a send that did land is not repeated.
    if (state.keyTarget !== target || !state.key) Object.assign(state, { key: crypto.randomUUID(), keyTarget: target });
    hold(state, true);
    say(state, '正在提交交接请求…');
    try {
      await call(view, '/api/messages', 'POST', handoffMessage(task, view.threadId, target, state.key));
      if (!current(view)) return;
      Object.assign(state, { sent: true, key: '', keyTarget: '' });
      say(state, `交接请求已提交给 ${catName(task.ownerCatId, view.cats)}。是否交接、由谁负责，以刷新后原生 Task 的负责成员为准。`);
    } catch (error) {
      if (current(view)) say(state, `没能确认交接请求已提交：${reason(error)}。`);
    } finally {
      if (current(view)) hold(state, false);
    }
  }

  window.ClowderTasks = Object.freeze({ load, progress, background, historical, stopMarked, canStop, canCancel, canResume, resumeWait, resumeLabel, controlBody, handoffBlocked, handoffTargets, handoffMessage, catName });
})();
