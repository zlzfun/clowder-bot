// 定时任务：信息抽屉「任务」里每只猫自己的一节。新建一次、每天、每周、间隔任务；
// 查看规则、消息、状态和投递聊天；暂停与恢复；确认后删除；查看最近的原生触发记录。
// Clowder AI 保存并执行任务，结果发到创建时绑定的单聊。这里只读写
// /xbot-api/bots/:name/routines（及 /:id、/:id/runs），不计时、不轮询、不排程：
// 列表只在挂载、改动之后和点「刷新」时读取。约定见 docs/schedules-api.md。
(() => {
  "use strict";
  const enc = encodeURIComponent;
  const pad = (n) => String(n).padStart(2, "0");
  const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const button = (cls, text, click) => { const b = node("button", cls, text); b.type = "button"; if (click) b.addEventListener("click", click); return b; };
  let seq = 0;
  const uid = (prefix) => "sched-" + prefix + "-" + ++seq;

  // ---- rules (no DOM, no network) ----
  const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // 周一在前；原生 0 是周日
  const KINDS = [["once", "一次"], ["daily", "每天"], ["weekly", "每周"], ["interval", "间隔"]];
  const NAME_MAX = 80, PROMPT_MAX = 16000, MINUTES_MAX = 10080;
  const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
  const EN_DAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  function zoneOk(zone) {
    if (typeof zone !== "string" || !zone.trim()) return false;
    try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
  }
  function localZone() {
    try { const zone = Intl.DateTimeFormat().resolvedOptions().timeZone; return zoneOk(zone) ? zone : ""; } catch { return ""; }
  }
  // Times are shown in this computer's zone (the one a once-time is typed in), named beside them.
  const shownZone = (serverZone) => localZone() || (zoneOk(serverZone) ? serverZone : "UTC");
  // A repeating task starts in this computer's zone; the zone the server reported is the other choice.
  function zoneChoices(serverZone) {
    const own = localZone(), out = [];
    if (own) out.push([own, own + "（本机）"]);
    if (zoneOk(serverZone) && serverZone !== own) out.push([serverZone, serverZone]);
    if (!out.length) out.push(["UTC", "UTC"]);
    return out;
  }

  const toMs = (value) => { if (typeof value === "number") return value; const t = Date.parse(value); return Number.isFinite(t) ? t : NaN; };
  function partsOf(ms, zone) {
    const out = {};
    const format = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    for (const p of format.formatToParts(new Date(ms))) out[p.type] = p.value;
    return out;
  }
  // 「11月5日 周四 09:00」, with the year when it is not this year; the caller names the zone.
  function instantText(ms, zone, now = Date.now()) {
    if (!Number.isFinite(ms)) return "";
    try {
      const p = partsOf(ms, zone), today = partsOf(now, zone);
      return (p.year !== today.year ? p.year + "年" : "") + Number(p.month) + "月" + Number(p.day) + "日 周" + WEEK[EN_DAY[p.weekday]] + " " + p.hour + ":" + p.minute;
    } catch { return new Date(ms).toISOString(); }
  }

  // The cron forms this module writes: "m h * * *" daily and "m h * * d,d" weekly.
  function cronParts(expression) {
    const f = String(expression || "").trim().split(/\s+/);
    if (f.length !== 5) return null;
    const [m, h, dom, mon, dow] = f;
    if (!/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(h) || Number(m) > 59 || Number(h) > 23 || dom !== "*" || mon !== "*") return null;
    const time = pad(Number(h)) + ":" + pad(Number(m));
    if (dow === "*") return { kind: "daily", time };
    const list = dow.split(",");
    if (!list.every((d) => /^[0-7]$/.test(d))) return null;
    const days = [...new Set(list.map((d) => Number(d) % 7))].sort((a, b) => a - b);
    return days.length === 7 ? { kind: "daily", time } : { kind: "weekly", time, days };
  }
  function daysText(days) {
    if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return "工作日";
    return "每周" + DAY_ORDER.filter((d) => days.includes(d)).map((d) => WEEK[d]).join("、");
  }
  function intervalText(ms) {
    const minutes = Number(ms) / 60000;
    if (!Number.isFinite(minutes) || minutes <= 0) return "间隔未知";
    if (Number.isInteger(minutes / 60)) return "每 " + minutes / 60 + " 小时";
    if (Number.isInteger(minutes)) return "每 " + minutes + " 分钟";
    return "每 " + Math.round(Number(ms) / 1000) + " 秒";
  }
  // The native trigger as one line, every clock time with its zone.
  function ruleText(trigger, zone, now = Date.now()) {
    const t = trigger || {};
    if (t.type === "once") {
      const ms = toMs(t.fireAt);
      return Number.isFinite(ms) ? "一次 · " + instantText(ms, zone, now) + "（" + zone + "）" : "一次 · 时间未知";
    }
    if (t.type === "interval") return intervalText(t.ms);
    if (t.type === "cron") {
      const where = "（" + (typeof t.timezone === "string" && t.timezone ? t.timezone : "未注明时区") + "）";
      const c = cronParts(t.expression);
      if (!c) return "自定义规则 " + String(t.expression || "") + where;
      return (c.kind === "daily" ? "每天" : daysText(c.days)) + " " + c.time + where;
    }
    return "规则未知";
  }

  const STATES = { scheduled: "已启用", paused: "已暂停", blocked: "暂不可触发", delivered: "已触发", failed: "触发失败", missed: "错过时间", unregistered: "未生效" };
  const FIRED = ["delivered", "failed", "missed"];
  const isPast = (r, now = Date.now()) => !!(r && r.trigger && r.trigger.type === "once" && toMs(r.trigger.fireAt) <= now);
  // enabled is the owner's choice; registered and effectiveEnabled say whether native will fire it.
  // A once-task that has fired keeps the outcome the server read from its last run.
  function stateOf(r, now = Date.now()) {
    if (isPast(r, now) && FIRED.includes(r.status)) return r.status;
    if (r.enabled === false) return "paused";
    if (r.registered === false) return "unregistered";
    if (r.effectiveEnabled === false) return "blocked";
    if (r.enabled === true && r.registered === true && r.effectiveEnabled === true) return "scheduled";
    return Object.hasOwn(STATES, r.status) ? r.status : "unknown";
  }
  const stateText = (key) => STATES[key] || "状态未知";
  // RUN_DELIVERED means the wake-up message was handed over, not that the work is done.
  function outcomeText(outcome) {
    const code = String(outcome || "");
    if (code === "RUN_DELIVERED") return { text: "已触发", bad: false };
    if (code === "RUN_FAILED") return { text: "触发失败", bad: true };
    if (code === "SKIP_MISSED_WINDOW") return { text: "错过时间", bad: false };
    if (code.startsWith("SKIP_")) return { text: "已跳过 · " + code, bad: false };
    return { text: "结果未知" + (code ? " · " + code : ""), bad: false };
  }
  function runTime(run) {
    const missed = run && run.outcome === "SKIP_MISSED_WINDOW";
    return toMs(missed ? run.scheduled_at || run.started_at : (run && (run.fired_at || run.started_at)));
  }
  function statsText(stats) {
    if (!stats || !(Number(stats.total) > 0)) return "";
    const parts = [["已触发", stats.delivered], ["失败", stats.failed], ["跳过", stats.skipped]].filter(([, n]) => Number(n) > 0).map(([label, n]) => label + " " + Number(n));
    return "共 " + Number(stats.total) + " 次" + (parts.length ? "：" + parts.join(" · ") : "");
  }

  // "2026-11-05T09:00" from <input type="datetime-local"> is this computer's wall time.
  function localInstant(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || ""));
    if (!m) return null;
    const [y, mo, d, h, mi] = m.slice(1, 6).map(Number), s = Number(m[6] || 0);
    const date = new Date(y, mo - 1, d, h, mi, s);
    if (Number.isNaN(date.getTime())) return null;
    // A wall time skipped by a daylight-saving change does not exist on this computer.
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== mi) return { gap: true };
    const off = -date.getTimezoneOffset(), abs = Math.abs(off);
    return { ms: date.getTime(), at: m[1] + "-" + m[2] + "-" + m[3] + "T" + m[4] + ":" + m[5] + ":" + pad(s) + (off < 0 ? "-" : "+") + pad(Math.floor(abs / 60)) + ":" + pad(abs % 60) };
  }
  const wallValue = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  // The next whole hour at least ten minutes away.
  function defaultOnce(now = Date.now()) { const d = new Date(now + 10 * 60000); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return wallValue(d); }

  // Form values → { body: {name, prompt, schedule} } or { issues }. Target and chat are bound by the server.
  function createBody(input, now = Date.now()) {
    const issues = [], name = String(input.name || "").trim(), prompt = String(input.prompt || "").trim();
    if (!name) issues.push({ field: "name", text: "请填写名称" });
    else if (name.length > NAME_MAX) issues.push({ field: "name", text: "名称最多 " + NAME_MAX + " 个字" });
    if (!prompt) issues.push({ field: "prompt", text: "请填写到时发给猫猫的消息" });
    else if (prompt.length > PROMPT_MAX) issues.push({ field: "prompt", text: "消息最多 " + PROMPT_MAX + " 个字" });
    let schedule = null;
    const kind = input.kind;
    if (kind === "once") {
      const at = localInstant(input.at);
      if (!at) issues.push({ field: "at", text: "请选择日期和时间" });
      else if (at.gap) issues.push({ field: "at", text: "这个时间因夏令时调整在本机不存在，请换一个" });
      else if (at.ms <= now) issues.push({ field: "at", text: "请选择以后的时间" });
      else schedule = { kind, at: at.at };
    } else if (kind === "daily" || kind === "weekly") {
      const time = String(input.time || "").slice(0, 5), timezone = String(input.timezone || "");
      const days = [...new Set((input.days || []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b);
      let ok = true;
      if (!TIME.test(time)) { issues.push({ field: "time", text: "请选择时间" }); ok = false; }
      if (kind === "weekly" && !days.length) { issues.push({ field: "days", text: "至少选一天" }); ok = false; }
      if (!zoneOk(timezone)) { issues.push({ field: "timezone", text: "请选择时区" }); ok = false; }
      if (ok) schedule = kind === "weekly" ? { kind, time, days, timezone } : { kind, time, timezone };
    } else if (kind === "interval") {
      const raw = String(input.minutes == null ? "" : input.minutes).trim(), minutes = Number(raw);
      if (!/^\d+$/.test(raw) || minutes < 1 || minutes > MINUTES_MAX) issues.push({ field: "minutes", text: "请填 1–" + MINUTES_MAX + " 之间的整数分钟" });
      else schedule = { kind, minutes };
    } else issues.push({ field: "kind", text: "请选择时间规则" });
    return issues.length ? { issues } : { body: { name, prompt, schedule } };
  }
  const fingerprint = (body) => JSON.stringify([body.name, body.prompt, body.schedule]);
  // One key per unchanged form: a retry of the same content cannot make a second task.
  function requestKey() {
    const c = window.crypto;
    if (c && typeof c.randomUUID === "function") { try { return c.randomUUID(); } catch { /* insecure context */ } }
    const bytes = new Uint8Array(16);
    if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }

  // The server's own words for a failure, when it gave some (never a whole page).
  function reason(err) {
    const raw = String((err && err.message) || "").trim();
    if (!raw || raw === "request failed" || raw === "unauthorized" || raw.startsWith("<") || raw.length > 600) return "";
    return raw.replace(/[。.]+$/, "");
  }
  const tail = (err) => { const why = reason(err); return why ? "：" + why : ""; };
  // No answer or a 5xx: the change may have been made.
  const unsure = (err) => !(err && err.status >= 400 && err.status < 500);

  // ---- focus ----
  const within = (box, n) => { for (; n; n = n.parentNode) if (n === box) return true; return false; };
  const focusLost = () => { const a = document.activeElement; return !a || a === document.body || !a.isConnected; };
  const owns = (box) => within(box, document.activeElement);
  function focusOn(target) {
    if (target && target.isConnected && !target.hidden && !target.disabled && typeof target.focus === "function") target.focus();
  }
  function trapTab(ev, card) {
    const all = [...card.querySelectorAll("button, input, select, textarea, a[href]")].filter((n) => !n.disabled && !n.hidden);
    if (!all.length) return;
    const first = all[0], last = all[all.length - 1], here = document.activeElement;
    if (ev.shiftKey ? here === first || !all.includes(here) : here === last || !all.includes(here)) {
      ev.preventDefault();
      (ev.shiftKey ? last : first).focus();
    }
  }

  // ---- the section ----
  let view = null;
  // A change that finished after its section closed: the open section of the same cat reads
  // its list again; nothing of the closed one comes back.
  function settledElsewhere(bot) { if (view && view.alive && view.bot === bot) view.load(); }

  function createView({ api, bot, icon }) {
    const glyph = (name, cls) => {
      let svg = null;
      try { svg = typeof icon === "function" ? icon(name) : null; } catch { svg = null; }
      if (svg && cls) svg.classList.add(cls);
      return svg;
    };
    const base = "/xbot-api/bots/" + enc(bot) + "/routines";
    const v = { bot, alive: true, list: null, failure: null, loading: false, seq: 0, latest: null, current: "", zone: "", rows: new Map(), form: null, layer: null };

    const root = node("section", "task-section sched");
    const title = node("h4", "", "定时任务");
    title.id = uid("title");
    root.setAttribute("aria-labelledby", title.id);
    const head = node("div", "sched-head"), tools = node("div", "sched-tools");
    const refreshBtn = button("text-btn sched-refresh", "刷新", () => { if (!v.loading) load(); });
    const addBtn = button("text-btn sched-add", "新建", () => openForm());
    addBtn.setAttribute("aria-expanded", "false");
    tools.append(refreshBtn, addBtn);
    head.append(title, tools);
    const status = node("p", "sched-status");
    status.setAttribute("role", "status"); status.hidden = true;
    const formSlot = node("div", "sched-form-slot");
    const wait = node("p", "sched-wait", "正在读取…");
    const fail = node("p", "sched-fail"), retry = button("text-btn sched-retry", "重试", () => { if (!v.loading) load(); });
    fail.setAttribute("role", "alert");
    const empty = node("p", "pnone sched-empty", "还没有定时任务。");
    const list = node("div", "sched-list");
    root.append(head, status, formSlot, wait, fail, retry, empty, list);

    // stale: the line reports a failed re-read, so the next good read clears it.
    function say(text, bad, stale) {
      status.textContent = text || ""; status.hidden = !text; status.classList.toggle("bad", !!bad);
      v.staleStatus = !!(text && stale);
    }

    // ---- the list ----
    function load() {
      if (!v.alive) return Promise.resolve({ ok: false });
      const mine = ++v.seq, hadFocus = document.activeElement === refreshBtn || document.activeElement === retry;
      v.loading = true;
      paintTop();
      const run = (async () => {
        let data = null, error = null;
        try {
          data = await api(base);
          if (!data || !Array.isArray(data.routines)) throw new Error("定时任务列表格式不对");
        } catch (err) { error = err || new Error("failed"); }
        if (!v.alive) return { ok: false };
        if (mine !== v.seq) return v.latest; // a later read decides
        v.loading = false;
        if (error) v.failure = error;
        else {
          v.failure = null;
          v.list = data.routines.filter((r) => r && typeof r === "object" && typeof r.id === "string" && r.id);
          v.current = typeof data.currentThreadId === "string" ? data.currentThreadId : "";
          v.zone = typeof data.timezone === "string" ? data.timezone : "";
        }
        if (!error) {
          if (v.staleStatus) say("");
          for (const row of v.rows.values()) if (row.noteStale) { row.note = ""; row.noteBad = row.noteStale = false; }
        }
        paint();
        if (error && v.list) say("没能刷新" + tail(error) + "。下面是上次读取的结果。", true, true);
        if (!error) for (const row of v.rows.values()) if (row.histOpen) loadRuns(row);
        if (hadFocus && focusLost()) focusOn(v.list && !error ? refreshBtn : retry.hidden ? refreshBtn : retry);
        return { ok: !error, error };
      })();
      v.latest = run;
      return run;
    }
    function paintTop() {
      title.textContent = "定时任务" + (v.list ? " · " + v.list.length : "");
      refreshBtn.disabled = v.loading;
      refreshBtn.textContent = v.loading && v.list ? "正在刷新…" : "刷新";
      wait.hidden = !(v.loading && !v.list);
      fail.textContent = v.failure && !v.list ? "没能读取定时任务" + tail(v.failure) + "。" : "";
      fail.hidden = !(v.failure && !v.list && !v.loading);
      retry.hidden = !(v.failure && !v.list);
      retry.disabled = v.loading;
      empty.hidden = !(v.list && !v.list.length);
    }
    function paint() {
      paintTop();
      const keep = new Set();
      let prev = null;
      for (const r of v.list || []) {
        let row = v.rows.get(r.id);
        if (!row) { row = makeRow(r.id); v.rows.set(r.id, row); }
        row.r = r;
        keep.add(r.id);
        paintRow(row);
        const spot = prev ? prev.nextSibling : list.firstChild;
        if (row.el !== spot) list.insertBefore(row.el, spot);
        prev = row.el;
      }
      for (const [id, row] of v.rows) {
        if (keep.has(id)) continue;
        const had = owns(row.el);
        row.histSeq++;
        row.el.remove();
        v.rows.delete(id);
        if (had) focusOn(addBtn);
      }
    }

    // ---- one task ----
    function makeRow(id) {
      const row = { id, r: null, open: false, busy: "", note: "", noteBad: false, histOpen: false, histSeq: 0, hist: null, sig: "" };
      const el = node("div", "sched-item");
      el.setAttribute("data-schedule", id);
      const bodyId = uid("body"), histId = uid("runs");
      const headBtn = button("sched-row", "", () => setOpen(row, !row.open));
      headBtn.setAttribute("aria-expanded", "false");
      headBtn.setAttribute("aria-controls", bodyId);
      const main = node("span", "sched-main"), line = node("span", "sched-line");
      const nameEl = node("b", "sched-name"), flag = node("span", "sched-flag"), sub = node("span", "sched-sub");
      const ruleEl = node("span", "sched-rule"), chatEl = node("span", "sched-chat");
      line.append(nameEl, flag);
      sub.append(ruleEl, " · ", chatEl);
      main.append(line, sub);
      const clock = glyph("alarm-clock"), chev = glyph("chevron", "sched-chev");
      if (clock) headBtn.append(clock);
      headBtn.append(main);
      if (chev) headBtn.append(chev);
      const body = node("div", "sched-body");
      body.id = bodyId; body.hidden = true;
      const prompt = node("p", "sched-prompt"), facts = node("dl", "sched-facts"), hint = node("p", "sched-hint");
      const actions = node("div", "sched-actions");
      const toggleBtn = button("secondary sched-toggle", "", () => toggle(row));
      const histBtn = button("secondary sched-runs-btn", "触发记录", () => setHist(row, !row.histOpen));
      histBtn.setAttribute("aria-expanded", "false");
      histBtn.setAttribute("aria-controls", histId);
      const delBtn = button("secondary sched-danger", "删除", () => askDelete(row));
      actions.append(toggleBtn, histBtn, delBtn);
      const msg = node("p", "sched-msg");
      msg.setAttribute("role", "status");
      const hist = node("div", "sched-runs-box");
      hist.id = histId; hist.hidden = true;
      const more = node("details", "task-details sched-ids"), summary = node("summary", "", "任务详情"), ids = node("dl", "sched-facts");
      const fold = glyph("chevron");
      if (fold) summary.append(fold);
      more.append(summary, ids);
      body.append(prompt, facts, hint, actions, msg, hist, more);
      el.append(headBtn, body);
      return Object.assign(row, { el, headBtn, nameEl, flag, ruleEl, chatEl, body, prompt, facts, hint, toggleBtn, histBtn, delBtn, msg, hist, ids });
    }
    const chatOf = (r) => r.currentThread === true || (r.currentThread !== false && !!r.threadId && r.threadId === v.current);
    function setText(target, text) { if (target.textContent !== text) target.textContent = text; }
    function paintRow(row) {
      const r = row.r, now = Date.now(), key = stateOf(r, now), past = isPast(r, now), zone = shownZone(v.zone);
      const name = typeof r.name === "string" && r.name.trim() ? r.name : "定时任务";
      const rule = ruleText(r.trigger, zone, now), current = chatOf(r);
      setText(row.nameEl, name);
      setText(row.flag, stateText(key));
      row.flag.classList.toggle("bad", key === "failed");
      const chat = current ? "当前聊天" : "创建时的聊天";
      setText(row.ruleEl, rule);
      setText(row.chatEl, chat);
      row.headBtn.setAttribute("aria-label", [name, stateText(key), rule, chat].join("，"));
      setText(row.prompt, typeof r.prompt === "string" ? r.prompt : "");
      const last = r.lastRun && typeof r.lastRun === "object" ? r.lastRun : null;
      const lastOutcome = last ? outcomeText(last.outcome) : null, lastAt = last ? runTime(last) : NaN;
      const lastText = last ? lastOutcome.text + (Number.isFinite(lastAt) ? " · " + instantText(lastAt, zone, now) + "（" + zone + "）" : "") : "还没有触发";
      const lastWhy = last && typeof last.error_summary === "string" ? last.error_summary.trim() : "";
      const hints = [], lapsed = past && (key === "missed" || key === "unregistered");
      if (key === "blocked") hints.push("已启用，但被全局暂停或治理规则挡住，暂时不会触发。");
      if (key === "unregistered" && !past) hints.push("运行时目前没有登记这个任务，不会按时触发。");
      if (lapsed) hints.push("错过的时间不会补跑，需要时请新建。");
      else if (past && key === "paused") hints.push("时间已过的一次任务不能恢复，需要时请新建。");
      if (key === "delivered" || (last && last.outcome === "RUN_DELIVERED")) hints.push("「已触发」只表示消息已发给猫猫，不代表工作已完成。");
      if (!current) hints.push("结果发到创建时的聊天，不会发到当前聊天。");
      const sig = JSON.stringify([rule, key, current, r.threadId, lastText, lastWhy, statsText(r.runStats), hints, r.id]);
      if (row.sig !== sig) {
        row.sig = sig;
        // The state is the row's own flag; the card adds what the row line cannot hold.
        const facts = [["规则", rule], ["发到", chat], ["上次", lastText]];
        const stats = statsText(r.runStats);
        if (stats) facts.push(["次数", stats]);
        row.facts.replaceChildren();
        for (const [label, value] of facts) {
          const dd = node("dd", "", value);
          if (label === "发到" && !current && typeof r.threadId === "string" && r.threadId) {
            const link = node("a", "sched-link", "在运行面板查看");
            link.href = "/runtime.html?thread=" + enc(r.threadId); link.target = "_blank"; link.rel = "noopener";
            dd.append(" · ", link);
          }
          if (label === "上次" && lastWhy) dd.append(node("span", "sched-why", lastWhy));
          row.facts.append(node("dt", "", label), dd);
        }
        row.hint.replaceChildren(...hints.map((text) => node("span", "", text)));
        row.hint.hidden = !hints.length;
        row.ids.replaceChildren(node("dt", "", "任务 ID"), idValue(r.id), node("dt", "", "聊天 ID"), idValue(r.threadId));
      }
      // Pause only what may still fire; a once-time that has passed cannot be resumed.
      const canPause = r.enabled === true && !FIRED.includes(key), canResume = r.enabled === false && !past;
      row.toggleBtn.hidden = !(canPause || canResume) && !row.busy;
      row.toggleBtn.textContent = row.busy === "pause" ? "正在暂停…" : row.busy === "resume" ? "正在恢复…" : canPause ? "暂停" : "恢复";
      row.toggleBtn.disabled = !!row.busy;
      row.delBtn.textContent = row.busy === "delete" ? "正在删除…" : "删除";
      row.delBtn.disabled = !!row.busy;
      row.msg.textContent = row.note;
      row.msg.hidden = !row.note;
      row.msg.classList.toggle("bad", row.noteBad);
    }
    function idValue(text) { const dd = node("dd"); dd.append(node("code", "sched-code", typeof text === "string" && text ? text : "—")); return dd; }
    function setOpen(row, open) {
      row.open = open;
      row.body.hidden = !open;
      row.el.classList.toggle("open", open);
      row.headBtn.setAttribute("aria-expanded", String(open));
    }
    function note(row, text, bad) {
      if (v.rows.get(row.id) === row) { row.note = text; row.noteBad = !!bad; paintRow(row); }
      else say(text, bad);
    }

    // ---- 暂停 / 恢复 ----
    async function toggle(row) {
      const r = row.r;
      if (!v.alive || row.busy || !r) return;
      const want = r.enabled !== true, verb = want ? "恢复" : "暂停", hadFocus = document.activeElement === row.toggleBtn;
      row.busy = want ? "resume" : "pause"; row.note = "";
      paintRow(row);
      let res = null, error = null;
      try { res = await api(base + "/" + enc(row.id), { method: "PATCH", body: { enabled: want } }); }
      catch (err) { error = err || new Error("failed"); }
      if (!v.alive) { settledElsewhere(bot); return; }
      row.busy = ""; row.noteStale = false;
      if (error) {
        const reread = !unsure(error) && (error.status === 404 || error.status === 409);
        note(row, unsure(error) ? "没能确认是否已" + verb + tail(error) + "。请刷新核对。" : "没能" + verb + tail(error) + "。" + (reread ? "已重新读取列表。" : ""), true);
        if (hadFocus && focusLost()) focusOn(row.toggleBtn);
        if (reread) load();
        return;
      }
      row.r = { ...row.r, enabled: res && typeof res.enabled === "boolean" ? res.enabled : want };
      const done = want ? "已恢复" : "已暂停";
      note(row, want ? "已恢复。" : "已暂停，之后不会再触发；已经开始的执行不受影响。");
      if (hadFocus && focusLost()) focusOn(row.toggleBtn.hidden ? row.headBtn : row.toggleBtn);
      const after = await load();
      if (!v.alive || !after) return;
      if (!after.ok) { note(row, done + "，但没能刷新列表" + tail(after.error) + "。", true); row.noteStale = true; }
    }

    // ---- 触发记录 ----
    function setHist(row, open) {
      row.histOpen = open;
      row.histBtn.setAttribute("aria-expanded", String(open));
      row.hist.hidden = !open;
      // Shut: a late answer is dropped and never opens it again.
      if (!open) { row.histSeq++; return; }
      loadRuns(row);
    }
    async function loadRuns(row) {
      const mine = ++row.histSeq;
      paintRuns(row, true);
      let data = null, error = null;
      try {
        data = await api(base + "/" + enc(row.id) + "/runs");
        if (!data || !Array.isArray(data.runs)) throw new Error("触发记录格式不对");
      } catch (err) { error = err || new Error("failed"); }
      if (!v.alive || mine !== row.histSeq || !row.histOpen) return;
      row.hist.removeAttribute("aria-busy");
      row.histData = error ? { error } : { runs: data.runs };
      paintRuns(row, false);
    }
    function paintRuns(row, loading) {
      const box = row.hist, data = row.histData, zone = shownZone(v.zone), now = Date.now(), kids = [];
      if (loading) box.setAttribute("aria-busy", "true");
      if (loading && !(data && data.runs)) kids.push(node("p", "sched-wait", "正在读取…"));
      else if (data && data.error) {
        const again = button("text-btn sched-retry", "重试", () => loadRuns(row));
        again.disabled = !!loading;
        kids.push(node("p", "sched-fail", "没能读取触发记录" + tail(data.error) + "。"), again);
      } else if (data && data.runs) {
        const runs = data.runs.filter((x) => x && typeof x === "object").slice(0, 50);
        if (loading) kids.push(node("p", "sched-wait", "正在刷新…"));
        if (!runs.length) kids.push(node("p", "pnone", "还没有触发记录。"));
        else {
          kids.push(node("p", "sched-runs-head", "最近 " + runs.length + " 条 · 时间为 " + zone));
          const items = node("ol", "sched-runs");
          for (const run of runs) {
            const item = node("li", "sched-run"), o = outcomeText(run.outcome), at = runTime(run), top = node("div", "sched-run-line");
            top.append(node("span", "sched-run-what" + (o.bad ? " bad" : ""), o.text), node("span", "sched-run-when", Number.isFinite(at) ? instantText(at, zone, now) : "时间未知"));
            item.append(top);
            const why = typeof run.error_summary === "string" ? run.error_summary.trim() : "";
            if (why) item.append(node("p", "sched-run-why", why));
            items.append(item);
          }
          kids.push(items);
        }
      }
      const hadFocus = owns(box);
      box.replaceChildren(...kids);
      if (hadFocus && focusLost()) {
        const again = kids.find((k) => k.tagName === "BUTTON" && !k.disabled);
        focusOn(again || row.histBtn);
      }
    }

    // ---- 删除：the original modal card, one at a time ----
    function askDelete(row) {
      if (!v.alive || row.busy || !row.r) return;
      if (v.layer) v.layer.close(false);
      const name = typeof row.r.name === "string" && row.r.name.trim() ? row.r.name : "定时任务";
      const opener = row.delBtn, shade = node("div", "modal sched-modal"), card = node("div", "modal-card sched-card");
      const h = node("h2", "", "删除「" + name + "」？"), text = node("p", "note", "删除后不会再触发。已经开始或排队的执行不会因此取消。");
      h.id = uid("dialog"); text.id = uid("dialog-text");
      card.setAttribute("role", "alertdialog"); card.setAttribute("aria-modal", "true");
      card.setAttribute("aria-labelledby", h.id); card.setAttribute("aria-describedby", text.id);
      const err = node("p", "error");
      err.setAttribute("role", "alert"); err.hidden = true;
      const bar = node("div", "modal-actions");
      const cancel = button("secondary", "取消", () => { if (!L.busy) L.close(true); });
      const go = button("secondary sched-danger", "删除", () => remove(row, L, name));
      bar.append(cancel, go);
      card.append(h, text, err, bar);
      shade.append(card);
      const L = {
        busy: false, closed: false, card, go,
        fail: (message) => { err.textContent = message || ""; err.hidden = !message; },
        setBusy: (on) => { L.busy = on; cancel.disabled = on; go.disabled = on; go.textContent = on ? "正在删除…" : "删除"; },
        close: (refocus) => {
          if (L.closed) return;
          L.closed = true;
          shade.remove();
          if (v.layer === L) v.layer = null;
          if (refocus) focusOn(opener);
        },
      };
      // Escape, Tab and every other key stay inside this layer, so the drawer stays open.
      shade.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") { ev.preventDefault(); if (!L.busy) L.close(true); }
        else if (ev.key === "Tab") trapTab(ev, card);
        ev.stopPropagation();
      });
      let downOnShade = false;
      shade.addEventListener("mousedown", (ev) => { downOnShade = ev.target === shade; });
      shade.addEventListener("click", (ev) => { if (ev.target === shade && downOnShade && !L.busy) L.close(true); downOnShade = false; });
      document.body.append(shade);
      v.layer = L;
      cancel.focus();
    }
    async function remove(row, L, name) {
      if (!v.alive || L.busy || L.closed || row.busy) return;
      L.fail(""); L.setBusy(true);
      row.busy = "delete";
      if (v.rows.get(row.id) === row) paintRow(row);
      let error = null;
      try { await api(base + "/" + enc(row.id), { method: "DELETE" }); }
      catch (err) { error = err || new Error("failed"); }
      if (!v.alive) { settledElsewhere(bot); return; }
      row.busy = "";
      if (v.rows.get(row.id) === row) paintRow(row);
      if (error && error.status === 404) {
        L.close(false);
        say("没能删除「" + name + "」" + tail(error) + "。已重新读取列表。", true);
        if (focusLost()) focusOn(row.el.isConnected ? row.delBtn : addBtn);
        load();
        return;
      }
      if (error) {
        L.setBusy(false);
        L.fail(unsure(error) ? "没能确认是否已删除" + tail(error) + "。请关闭后刷新列表核对。" : "没能删除" + tail(error) + "。");
        if (focusLost()) L.go.focus();
        return;
      }
      const hadFocus = owns(L.card) || focusLost();
      L.close(false);
      // Gone: drop the row at once, then read the list again.
      const at = v.list ? v.list.findIndex((x) => x.id === row.id) : -1;
      if (v.list) v.list = v.list.filter((x) => x.id !== row.id);
      paint();
      say("已删除「" + name + "」，之后不会再触发；已经开始的执行不受影响。");
      if (hadFocus) {
        const rest = (v.list || []).map((x) => v.rows.get(x.id)).filter(Boolean);
        const next = rest[Math.min(Math.max(at, 0), rest.length - 1)];
        focusOn(next ? next.headBtn : addBtn);
      }
      const after = await load();
      if (!v.alive || !after) return;
      if (!after.ok) say("已删除「" + name + "」，但没能刷新列表" + tail(after.error) + "。", true, true);
    }

    // ---- 新建 ----
    function openForm() {
      if (!v.alive) return;
      if (!v.form) {
        v.form = buildForm();
        formSlot.append(v.form.el);
        addBtn.setAttribute("aria-expanded", "true");
        addBtn.setAttribute("aria-controls", v.form.el.id);
      }
      v.form.focus();
    }
    function closeForm(refocus) {
      const f = v.form;
      if (!f) return;
      v.form = null;
      f.el.remove();
      addBtn.setAttribute("aria-expanded", "false");
      if (refocus) focusOn(addBtn);
    }
    function buildForm() {
      const now = Date.now(), today = new Date(now).getDay();
      const el = node("form", "sched-form");
      el.id = uid("form");
      el.setAttribute("novalidate", "");
      el.setAttribute("aria-label", "新建定时任务");
      const set = node("fieldset", "sched-fields"), issues = {};
      function field(key, label, control, extra) {
        const box = node("div", "field sched-field"), lab = node("label", "", label), err = node("p", "sched-err");
        control.id = uid(key);
        lab.htmlFor = control.id;
        err.id = uid(key + "-err"); err.hidden = true;
        box.append(lab, control);
        if (extra) { extra.id = uid(key + "-hint"); control.setAttribute("aria-describedby", extra.id); box.append(extra); }
        box.append(err);
        issues[key] = { err, control, focus: control, hint: extra ? extra.id : "" };
        return box;
      }
      function input(type, attrs) { const n = node("input"); n.type = type; Object.assign(n, attrs || {}); return n; }
      const nameIn = input("text", { maxLength: NAME_MAX, autocomplete: "off" });
      const promptIn = node("textarea");
      promptIn.rows = 3; promptIn.maxLength = PROMPT_MAX; promptIn.placeholder = "到时发给猫猫的话";
      const nameBox = field("name", "名称", nameIn), promptBox = field("prompt", "消息", promptIn);

      const kindBox = node("div", "field sched-field"), kindLabel = node("span", "", "时间规则"), kinds = node("div", "choice sched-kinds"), kindErr = node("p", "sched-err");
      kindLabel.id = uid("kind");
      kinds.setAttribute("role", "radiogroup");
      kinds.setAttribute("aria-labelledby", kindLabel.id);
      kindErr.id = uid("kind-err"); kindErr.hidden = true;
      const group = uid("kinds");
      const radios = KINDS.map(([value, text]) => {
        const opt = node("label", "choice-opt"), radio = input("radio", { name: group, value, checked: value === "once" });
        radio.addEventListener("change", () => { if (radio.checked) showKind(); });
        opt.append(radio, text);
        kinds.append(opt);
        return radio;
      });
      kindBox.append(kindLabel, kinds, kindErr);
      issues.kind = { err: kindErr, control: kinds, focus: radios[0] };

      const zone = localZone();
      const atIn = input("datetime-local", { value: defaultOnce(now), min: wallValue(new Date(now)), step: 60 });
      const atBox = field("at", "日期和时间", atIn, node("p", "sched-hint", "按本机时区" + (zone ? "（" + zone + "）" : "")));
      const timeIn = input("time", { value: "09:00", step: 60 });
      const timeBox = field("time", "时间", timeIn);
      const daysBox = node("div", "field sched-field"), daysLabel = node("span", "", "星期"), days = node("div", "sched-days"), daysErr = node("p", "sched-err");
      daysLabel.id = uid("days");
      days.setAttribute("role", "group");
      days.setAttribute("aria-labelledby", daysLabel.id);
      daysErr.id = uid("days-err"); daysErr.hidden = true;
      const dayBoxes = DAY_ORDER.map((d) => {
        const lab = node("label", "sched-day"), box = input("checkbox", { value: String(d), checked: d === today });
        box.setAttribute("aria-label", "周" + WEEK[d]);
        lab.append(box, node("span", "", WEEK[d]));
        days.append(lab);
        return box;
      });
      daysBox.append(daysLabel, days, daysErr);
      issues.days = { err: daysErr, control: days, focus: dayBoxes[0] };
      const zoneSel = node("select");
      const picked = zoneChoices(v.zone);
      for (const [value, text] of picked) { const o = node("option", "", text); o.value = value; zoneSel.append(o); }
      zoneSel.value = picked[0][0];
      const zoneBox = field("timezone", "时区", zoneSel);
      const minIn = input("number", { value: "60", min: 1, max: MINUTES_MAX, step: 1, inputMode: "numeric" });
      // Native interval rules: wait one interval after create or resume; a runtime restart checks once at start.
      const minBox = field("minutes", "间隔（分钟）", minIn, node("p", "sched-hint", "1–" + MINUTES_MAX + " 分钟。创建或恢复后先等满一个间隔；运行时重启后会立即检查一次。要固定钟点请选每天或每周。"));

      set.append(nameBox, promptBox, kindBox, atBox, timeBox, daysBox, zoneBox, minBox);
      const notes = node("p", "sched-note");
      notes.append(node("span", "", "结果发到当前聊天。"), node("span", "", "需要运行时和电脑在线；离线时错过的一次任务不会补跑。不会发后台通知或手机推送。"));
      const error = node("p", "error sched-error");
      error.setAttribute("role", "alert"); error.hidden = true;
      const actions = node("div", "modal-actions");
      const cancel = button("secondary", "取消", () => { if (!f.saving) closeForm(true); });
      const ok = node("button", "primary", "创建");
      ok.type = "submit";
      actions.append(cancel, ok);
      el.append(set, notes, error, actions);

      const f = { el, saving: false, attempt: null, focus: () => focusOn(nameIn) };
      const kind = () => (radios.find((r) => r.checked) || {}).value;
      function showKind() {
        const k = kind();
        atBox.hidden = k !== "once";
        timeBox.hidden = zoneBox.hidden = !(k === "daily" || k === "weekly");
        daysBox.hidden = k !== "weekly";
        minBox.hidden = k !== "interval";
        clear("kind");
      }
      function clear(key) {
        const issue = issues[key];
        if (!issue) return;
        issue.err.textContent = ""; issue.err.hidden = true;
        issue.control.removeAttribute("aria-invalid");
        if (issue.hint) issue.control.setAttribute("aria-describedby", issue.hint);
        else issue.control.removeAttribute("aria-describedby");
      }
      const clearAll = () => { for (const key of Object.keys(issues)) clear(key); };
      for (const [key, control] of [["name", nameIn], ["prompt", promptIn], ["at", atIn], ["time", timeIn], ["timezone", zoneSel], ["minutes", minIn]]) {
        control.addEventListener("input", () => clear(key));
        control.addEventListener("change", () => clear(key));
      }
      for (const box of dayBoxes) box.addEventListener("change", () => clear("days"));
      function showError(text) { error.textContent = text || ""; error.hidden = !text; }
      function busy(on) {
        f.saving = on;
        set.disabled = on; cancel.disabled = on; ok.disabled = on;
        ok.textContent = on ? "正在创建…" : "创建";
      }
      const read = () => ({
        name: nameIn.value, prompt: promptIn.value, kind: kind(), at: atIn.value, time: timeIn.value, timezone: zoneSel.value,
        days: dayBoxes.filter((b) => b.checked).map((b) => Number(b.value)), minutes: minIn.value,
      });

      async function submit() {
        if (!v.alive || f.saving || v.form !== f) return;
        clearAll(); showError("");
        const made = createBody(read(), Date.now());
        if (made.issues) {
          for (const issue of made.issues) {
            const it = issues[issue.field];
            if (!it) continue;
            it.err.textContent = issue.text; it.err.hidden = false;
            it.control.setAttribute("aria-invalid", "true");
            it.control.setAttribute("aria-describedby", [it.err.id, it.hint].filter(Boolean).join(" "));
          }
          const first = issues[made.issues[0].field];
          if (first) focusOn(first.focus);
          return;
        }
        // The same content reuses its key; any change is a new request.
        const print = fingerprint(made.body);
        if (!f.attempt || f.attempt.print !== print) f.attempt = { print, key: requestKey() };
        const body = { name: made.body.name, prompt: made.body.prompt, schedule: made.body.schedule, idempotencyKey: f.attempt.key };
        busy(true);
        let created = null, failure = null;
        try { created = await api(base, { method: "POST", body }); }
        catch (err) { failure = err || new Error("failed"); }
        if (!v.alive) { settledElsewhere(bot); return; }
        if (v.form !== f) return;
        if (failure) {
          busy(false);
          showError(unsure(failure)
            ? "没能确认是否已创建" + tail(failure) + "。请先点「刷新」核对列表，没有再重试。"
            : "没能创建" + tail(failure) + "。");
          if (focusLost() || owns(el)) focusOn(ok);
          return;
        }
        const hadFocus = owns(el) || focusLost();
        f.saving = false;
        f.attempt = null;
        closeForm(hadFocus);
        const name = created && typeof created.name === "string" && created.name ? created.name : body.name;
        say("已创建「" + name + "」，正在刷新列表…");
        const after = await load();
        if (!v.alive || !after) return;
        // Created is created: a failed re-read is reported apart and never invites a second create.
        if (after.ok) say("已创建「" + name + "」。");
        else say("已创建「" + name + "」，但没能刷新列表" + tail(after.error) + "。点「刷新」再试，不用重新创建。", true, true);
      }
      el.addEventListener("submit", (ev) => { ev.preventDefault(); submit(); });
      // Escape closes the form, not the drawer; it waits while a create is on its way.
      el.addEventListener("keydown", (ev) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault(); ev.stopPropagation();
        if (!f.saving) closeForm(true);
      });
      showKind();
      return f;
    }

    v.load = load;
    v.dispose = () => {
      if (!v.alive) return;
      v.alive = false;
      v.seq++;
      for (const row of v.rows.values()) row.histSeq++;
      if (v.layer) v.layer.close(false);
      root.remove();
    };
    v.root = root;
    paintTop();
    return v;
  }

  // Called on every task-view sync: cheap when nothing changed. A section moved into a new
  // task view (the tab was rebuilt) reads its list again; another cat gets a new section.
  function mount(host, opts) {
    if (!host || !opts || typeof opts.api !== "function" || typeof opts.bot !== "string" || !opts.bot) return null;
    if (view && view.alive && view.bot === opts.bot) {
      if (view.root.parentNode !== host) { host.append(view.root); view.load(); }
      else if (host.lastElementChild !== view.root) host.append(view.root);
      return view.root;
    }
    teardown();
    view = createView(opts);
    host.append(view.root);
    view.load();
    return view.root;
  }
  // Another cat, no cat or a deleted one: the section, its dialog and its pending answers go.
  function teardown() { const v = view; view = null; if (v) v.dispose(); }
  // The drawer opened again over a section still in place: read the list again.
  function reopened() { if (view && view.alive && view.root.isConnected) view.load(); }

  window.ClowderSchedules = Object.freeze({
    mount, teardown, reopened,
    rules: Object.freeze({ zoneOk, localZone, zoneChoices, instantText, cronParts, ruleText, stateOf, stateText, outcomeText, statsText, localInstant, defaultOnce, createBody, fingerprint, requestKey, reason, unsure }),
  });
})();
