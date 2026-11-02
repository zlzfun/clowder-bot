// Local Agents are how a Bot reaches Clowder AI: each Bot runs on one Agent
// already installed on this computer (Codex, Claude Code…) and keeps that
// Agent's own login, model and effort. /xbot-api/agents projects native
// discovery plus the Bot threads this product manages. Nothing here installs,
// logs in, or calls a model, and a binding only changes on an explicit choice.
(() => {
  const node = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls || ""; if (text != null) n.textContent = text; return n; };
  const button = (cls, text, click) => { const b = node("button", cls, text); b.type = "button"; if (click) b.onclick = click; return b; };
  const dot = kind => { const d = node("span", "sdot " + kind); d.setAttribute("aria-hidden", "true"); return d; };

  // Readiness is evidence of a login or a config, never "connected" or "running".
  // An unrecognised status reads as unknown, so nothing is claimed by accident.
  const READY = {
    configured: { dot: "ok", text: "已有登录或配置记录", short: "已有配置记录" },
    login_required: { dot: "off", text: "需要先登录", short: "需要先登录" },
    unknown: { dot: "idle", text: "未确认登录状态", short: "未确认登录" },
    not_installed: { dot: "off", text: "未检测到", short: "未检测到" },
  };
  function readiness(agent) {
    const status = agent && agent.readiness && agent.readiness.status;
    const key = Object.hasOwn(READY, status) ? status : "unknown";
    return { status: key, ...READY[key] };
  }
  // The server decides; the client still refuses what the contract forbids.
  function selectable(agent) {
    const status = agent && agent.readiness && agent.readiness.status;
    return !!agent && agent.selectable === true && agent.installed === true && agent.supported === true
      && status !== "login_required" && status !== "not_installed";
  }
  function unavailable(agent) {
    if (selectable(agent)) return "";
    if (agent && agent.unavailableReason) return agent.unavailableReason;
    if (!agent || !agent.installed) return "本机尚未检测到这个 Agent";
    if (!agent.supported) return "这个 Agent 的接入方式还没适配";
    return "需要先在本机完成登录";
  }
  // The short tag for a row that cannot be chosen.
  function blocked(agent) {
    const status = readiness(agent).status;
    if (!agent.installed || status === "not_installed") return "未检测到";
    if (!agent.supported) return "暂未适配";
    return status === "login_required" ? "需要先登录" : "暂不可选";
  }
  // A new Bot starts on an Agent with login evidence when there is one.
  function preferred(agents) {
    const open = (agents || []).filter(selectable);
    return open.find(a => readiness(a).status === "configured") || open[0] || null;
  }
  // Counts only the Bot threads clowder-bot manages: an Agent session opened in
  // a terminal or a desktop app never shows here, and unknown is not idle.
  function activity(agent) {
    const a = (agent && agent.activity) || {};
    if (a.state !== "running" && a.state !== "idle") return "状态未知";
    const parts = [];
    if (a.state === "running") parts.push((a.active > 0 ? a.active + " 个" : "") + "执行中");
    if (a.queued > 0) parts.push(a.queued + " 个排队");
    return parts.join(" · ") || "空闲";
  }
  function defaults(agent) {
    const parts = [agent && agent.configuredModel, agent && agent.configuredEffort ? "推理强度 " + agent.configuredEffort : ""].filter(Boolean);
    return parts.length ? parts.join(" · ") : "未读取到，由 Agent 自己决定";
  }
  // The Bot's side (panel `agent`). A managed account or any other native
  // carrier is kept read-only and never shown as a connected local Agent.
  function binding(agent) {
    if (!agent) return { local: false, id: null, title: "未读取", detail: "", override: "" };
    const override = agent.modelOverride || "";
    if (!agent.id || agent.configurationSource !== "native_tool") {
      return { local: false, id: null, title: agent.label || "其他原生接入", detail: "原有接入，只读保留" + (override ? " · " + override : ""), override };
    }
    const detail = override ? "Bot 单独指定 " + override : "沿用本机默认" + (agent.configuredModel ? " · " + agent.configuredModel : "");
    return { local: true, id: agent.id, title: agent.label || agent.id, detail, override };
  }
  // Choosing the current Agent again only matters when it clears an override.
  function unchanged(view, agent) { return !!agent && view.local && view.id === agent.id && !view.override; }
  function impact(bot, agent, view) {
    const name = agent.label || agent.id;
    let text = view.local && view.id === agent.id
      ? `确认后，清除「${bot}」单独指定的模型 ${view.override}，改为沿用 ${name} 在本机的默认配置。`
      : `确认后，「${bot}」改由 ${name} 执行：清除这个 Bot 单独设置的账号、模型和推理强度，之后沿用 ${name} 在本机的默认配置。`;
    text += "聊天记录会保留。";
    if (readiness(agent).status !== "configured") text += `还没确认 ${name} 已登录；如果没登录，下一次执行会失败。`;
    return text;
  }
  function bind(api, bot, runtimeId) {
    return api("/xbot-api/bots/" + encodeURIComponent(bot) + "/agent", { method: "PUT", body: { runtimeId } });
  }
  // The server's own words come first: a 409 may mean work in flight or a
  // member edited elsewhere, so an unexplained one is only called a conflict.
  function bindError(err, bot) {
    const message = String((err && err.message) || "");
    if (/[㐀-鿿]/.test(message)) return message;
    if (err && err.status === 409) return `「${bot}」的配置刚有变化，没能更换 Agent。请关闭后重新打开，核对当前设置再试。`;
    return "没能更换 Agent，请稍后再试。";
  }
  async function inventory(api, refresh = false) {
    const data = await api("/xbot-api/agents" + (refresh ? "?refresh=1" : ""));
    return { agents: Array.isArray(data && data.agents) ? data.agents : [], checkedAt: (data && data.checkedAt) || null };
  }
  const clock = ms => new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const when = ms => new Date(ms).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

  function state(agent) {
    const ready = readiness(agent), box = node("span", "agent-state");
    box.append(dot(ready.dot), node("span", "", ready.text));
    if (agent.readiness && agent.readiness.checkedAt) box.title = "检测于 " + when(agent.readiness.checkedAt);
    return box;
  }
  function loginHint(agent) {
    const command = agent.readiness && agent.readiness.loginCommand, hint = node("p", "agent-hint");
    if (!command) { hint.textContent = "在终端里完成这个 Agent 的登录，再点「重新检测」。"; return hint; }
    hint.append("在终端运行 ", node("code", "", command), " 完成登录，再点「重新检测」。");
    return hint;
  }
  function row(agent) {
    const ok = selectable(agent), ready = readiness(agent);
    const item = node("div", "agent-row" + (ok ? "" : " off")), head = node("div", "agent-head"), name = node("div", "agent-name");
    name.append(node("b", "", agent.label || agent.id));
    if (agent.command) name.append(node("code", "agent-cmd", agent.command));
    head.append(name, state(agent)); item.append(head);
    if (!ok) item.append(node("p", "agent-hint", unavailable(agent)));
    if (ready.status === "login_required") item.append(loginHint(agent));
    if (agent.installed) {
      const facts = node("dl", "agent-facts"), bots = (agent.bots || []).map(b => b.name).filter(Boolean);
      const fact = (k, v) => facts.append(node("dt", "", k), node("dd", "", v));
      fact("本机默认", defaults(agent));
      fact("接入的 Bot", bots.length ? bots.join("、") : "还没有");
      if (bots.length || (agent.activity && agent.activity.state === "running")) fact("Bot 会话", activity(agent));
      item.append(facts);
    }
    if (ok && ready.status === "unknown") item.append(node("p", "agent-hint", "没能确认是否已登录。仍可选用；如果没登录，Bot 执行时会由 Agent 报错。"));
    return item;
  }

  let teardown = () => {};
  async function settings({ api, host, isCurrent = () => true }) {
    teardown();
    let alive = true, busy = false;
    const current = () => alive && isCurrent();
    teardown = () => { alive = false; host.replaceChildren(); };
    host.className = "web-search-settings agent-settings";
    const tools = node("div", "agent-tools"), stamp = node("span", "agent-stamp");
    stamp.setAttribute("role", "status");
    const again = button("btn sec", "重新检测", () => load(true));
    tools.append(stamp, again);
    const error = node("p", "ws-error"); error.setAttribute("role", "alert"); error.hidden = true;
    const body = node("div", "agent-body"), foot = node("div", "agent-foot");
    const runtime = node("a", "", "在运行面板查看原生详情"); runtime.href = "/runtime.html"; runtime.target = "_blank"; runtime.rel = "noopener";
    const more = node("p", "setfoot"); more.append(runtime);
    foot.append(
      node("p", "setfoot", "「已有登录或配置记录」只说明检测到了登录或配置，不代表 Agent 已在运行，也不保证额度和网络可用。检测不会安装、登录，也不会调用模型。"),
      node("p", "setfoot", "「Bot 会话」只统计 clowder-bot 管理的会话；在终端或桌面端另开的 Agent 会话不在其中。"),
      more,
    );
    host.replaceChildren(node("h2", "", "本地 Agent"), node("p", "setlead", "Bot 交给这台电脑上已安装的 Agent 执行，登录、模型和推理强度都沿用 Agent 自己的配置。每个 Bot 在详情里选用一个。"), tools, error, body, foot);
    function group(title, agents) {
      const sec = node("div", "setsec"), list = node("div", "agent-list");
      for (const agent of agents) list.append(row(agent));
      sec.append(node("h4", "", title), list);
      return sec;
    }
    function paint(agents) {
      const open = agents.filter(selectable), closed = agents.filter(a => !selectable(a));
      body.replaceChildren();
      if (!agents.length) { body.append(node("p", "agent-none", "没有检测到 Agent。在这台电脑上安装 Codex、Claude Code 等 Agent 后，点「重新检测」。")); return; }
      if (!open.length) body.append(node("p", "agent-none", "暂时没有可以选用的 Agent。按下面的提示完成安装或登录后，点「重新检测」。"));
      if (open.length) body.append(group("可以选用", open));
      if (closed.length) body.append(group("暂不能选用", closed));
    }
    async function load(refresh) {
      if (busy || !current()) return;
      busy = true; again.disabled = true; error.hidden = true;
      stamp.textContent = refresh ? "正在重新检测…" : "正在读取…";
      try {
        const data = await inventory(api, refresh);
        if (!current()) return;
        paint(data.agents);
        stamp.textContent = data.checkedAt ? "读取于 " + clock(data.checkedAt) : "";
      } catch {
        if (!current()) return;
        stamp.textContent = "";
        error.textContent = "没能读取本地 Agent，请稍后点「重新检测」。"; error.hidden = false;
      } finally { busy = false; if (current()) again.disabled = false; }
    }
    await load(false);
  }

  // Radio rows: the checked one (or the first live one) takes Tab, arrows move and pick.
  function roving(group, rows, pick) {
    const sync = () => {
      const live = rows.filter(b => !b.disabled), on = live.find(b => b.getAttribute("aria-checked") === "true") || live[0];
      for (const b of rows) b.tabIndex = b === on ? 0 : -1;
    };
    group.onkeydown = ev => {
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[ev.key];
      const live = rows.filter(b => !b.disabled), i = live.indexOf(ev.target);
      if (!step || i < 0) return;
      ev.preventDefault();
      const next = live[(i + step + live.length) % live.length];
      next.focus(); pick(next);
    };
    sync();
    return sync;
  }

  let activeDialog = null;
  // 更换执行 Agent: a row click only stages; 改用此 Agent commits it. Rows that
  // cannot be chosen stay visible with their reason.
  async function open({ api, data, onBound, manage, opener, busy = () => false }) {
    if (activeDialog) return;
    const view = binding(data.agent);
    const dialog = node("dialog", "binding-dialog agent-dialog"); activeDialog = dialog; dialog.tabIndex = -1;
    let pending = null, saving = false;
    const close = () => { dialog.close(); dialog.remove(); activeDialog = null; if (opener && opener.isConnected) opener.focus(); };
    dialog.addEventListener("cancel", ev => { ev.preventDefault(); if (!saving) close(); });
    dialog.addEventListener("keydown", ev => { if (ev.key === "Escape") ev.stopPropagation(); });
    dialog.addEventListener("click", ev => {
      const r = dialog.getBoundingClientRect();
      if (ev.target === dialog && !saving && (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom)) close();
    });
    const head = node("div", "binding-head"), titles = node("div", "binding-titles"), title = node("h2", "", "更换执行 Agent");
    title.id = "agent-dialog-title"; dialog.setAttribute("aria-labelledby", title.id);
    const now = !data.agent ? "当前 Agent 未读取" : "当前 " + view.title + (view.local ? "" : "（只读保留）");
    titles.append(title, node("p", "binding-sub", `${data.name} · ${now}`));
    const x = button("binding-close", "×", () => { if (!saving) close(); }); x.setAttribute("aria-label", "关闭");
    head.append(titles, x);
    const body = node("div", "binding-body"), note = node("p", "binding-note"), error = node("p", "bad"); error.setAttribute("role", "alert");
    const footer = node("div", "binding-footer"), cancel = button("secondary", "取消", () => { if (!saving) close(); });
    const use = button("primary", "改用此 Agent", commit); use.disabled = true;
    footer.append(button("binding-manage", "本地 Agent 设置…", () => { if (!saving) { close(); manage(); } }), cancel, use);
    dialog.append(head, body, note, error, footer); document.body.append(dialog); dialog.showModal(); dialog.focus();
    const flat = (text, ...actions) => { const n = node("div", "binding-flat"); n.append(node("p", "", text), ...actions); return n; };
    const options = [];
    let sync = () => {};
    function stage(agent) {
      if (saving) return; // the choice being saved stays the choice shown
      pending = agent;
      for (const b of options) b.setAttribute("aria-checked", String(b._agent === agent));
      sync();
      use.disabled = unchanged(view, agent);
      note.textContent = use.disabled ? "" : impact(data.name, agent, view) + (busy() ? `「${data.name}」现在有任务在执行或排队，要等完成或停止后才能更换。` : "");
    }
    async function commit() {
      if (!pending || saving || unchanged(view, pending)) return;
      const chosen = pending;
      saving = true; use.disabled = cancel.disabled = true; error.textContent = "";
      try {
        const result = await bind(api, data.name, chosen.id);
        saving = false; close();
        if (onBound) await onBound((result && result.agent) || null, chosen);
      } catch (err) { error.textContent = bindError(err, data.name); }
      finally { saving = false; if (dialog.isConnected) { cancel.disabled = false; use.disabled = !pending || unchanged(view, pending); } }
    }
    async function load() {
      body.replaceChildren(flat("正在读取本地 Agent…")); options.length = 0;
      let agents;
      try { ({ agents } = await inventory(api)); }
      catch { if (dialog.isConnected) body.replaceChildren(flat("没能读取本地 Agent", button("secondary", "重试", load))); return; }
      if (!dialog.isConnected) return;
      if (!agents.length) { body.replaceChildren(flat("没有检测到 Agent", button("secondary", "查看本地 Agent", () => { close(); manage(); }))); return; }
      // One radio group across both sections; disabled rows are skipped.
      const group = node("div", "agent-groups"); group.setAttribute("role", "radiogroup"); group.setAttribute("aria-labelledby", title.id);
      const open = agents.filter(selectable), closed = agents.filter(a => !selectable(a));
      let initial = null;
      for (const [label, list] of [["可以选用", open], ["暂不能选用", closed]]) {
        if (!list.length) continue;
        const section = node("section", "binding-section"), rows = node("div", "binding-group");
        section.append(node("h3", "binding-heading", label));
        for (const agent of list) {
          const ok = selectable(agent), b = button("binding-option agent-option", "", () => stage(agent));
          b._agent = agent; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", "false"); b.disabled = !ok;
          const tx = node("span", "agent-option-tx"), caps = node("span", "binding-cap");
          tx.append(node("strong", "", agent.label || agent.id), node("small", "", ok ? "本机默认 " + defaults(agent) : unavailable(agent)));
          if (ok) caps.append(dot(readiness(agent).dot), node("span", "", readiness(agent).short));
          else caps.textContent = blocked(agent);
          b.append(tx, caps); rows.append(b); options.push(b);
          if (ok && view.local && agent.id === view.id) initial = agent;
        }
        section.append(rows); group.append(section);
      }
      body.replaceChildren(group);
      sync = roving(group, options, b => stage(b._agent));
      if (initial) stage(initial);
      (options.find(b => b.tabIndex === 0) || use).focus({ preventScroll: true });
    }
    await load();
  }

  // The Bot's Agent face in 详情 and 编辑资料: label over how it is configured.
  function trigger({ api, data, aside, manage, onBound, busy }) {
    const b = button("binding-trigger agent-trigger", "", () => open({ api, data, manage, busy, opener: b, onBound: async (agent, picked) => {
      if (agent) data.agent = agent;
      paint();
      if (onBound) await onBound(agent, picked);
    } }));
    b.setAttribute("aria-haspopup", "dialog");
    const paint = () => {
      const view = binding(data.agent), tx = node("span", "bt-tx");
      tx.append(node("strong", "bt-model agent-label" + (!data.agent ? " unset" : view.local ? "" : " legacy"), view.title));
      if (view.detail) tx.append(node("span", "bt-sub", view.detail));
      const chev = node("span", "skchev"); chev.setAttribute("aria-hidden", "true");
      b.replaceChildren(tx, ...(aside ? [aside] : []), chev);
      b.setAttribute("aria-label", `执行 Agent：${view.title}${view.detail ? "，" + view.detail : ""}，点按更换`);
    };
    paint();
    return b;
  }

  // 新建 Bot: only Agents that can be chosen, preselected to one with login
  // evidence. `onChange(id)` reports the choice; `value()` reads it at submit.
  function field({ api, onChange = () => {}, manage }) {
    const box = node("div", "field agent-field"), list = node("div", "ws-list agent-choices"), note = node("p", "agent-hint");
    list.setAttribute("role", "radiogroup"); list.setAttribute("aria-label", "执行 Agent");
    box.append(node("span", "", "执行 Agent"), list, note);
    let chosen = "", rows = [], sync = () => {}, lead = "";
    const pick = (row) => {
      const agent = row._agent, name = agent.label || agent.id;
      chosen = agent.id;
      for (const r of rows) { const on = r === row; r.classList.toggle("on", on); r.setAttribute("aria-checked", String(on)); }
      note.textContent = lead + (readiness(agent).status === "configured" ? "" : `还没确认 ${name} 已登录；如果没登录，第一次执行会失败。`);
      sync(); onChange(chosen);
    };
    const flat = (text, ...actions) => { const n = node("div", "agent-none"); n.append(node("p", "", text), ...actions); list.replaceChildren(n); };
    async function load(refresh) {
      chosen = ""; rows = []; lead = ""; onChange("");
      flat(refresh ? "正在重新检测本地 Agent…" : "正在检测本地 Agent…"); note.textContent = "";
      let agents;
      try { ({ agents } = await inventory(api, refresh)); }
      catch { if (box.isConnected) flat("没能读取本地 Agent。", button("btn sec", "重试", () => load(refresh))); return; }
      if (!box.isConnected) return;
      const open = agents.filter(selectable);
      if (!open.length) {
        const actions = [button("btn sec", "重新检测", () => load(true))];
        if (manage) actions.push(button("btn ghost", "查看本地 Agent", manage));
        flat("这台电脑上还没有可以选用的 Agent。先在终端安装并登录 Codex、Claude Code 等 Agent，再点「重新检测」。", ...actions);
        return;
      }
      list.replaceChildren();
      for (const agent of open) {
        const ready = readiness(agent), row = button("ws-provider agent-choice", "", () => pick(row));
        row._agent = agent; row.setAttribute("role", "radio"); row.setAttribute("aria-checked", "false");
        row.append(node("span", "ws-radio"), node("span", "ws-name", agent.label || agent.id), node("span", "ws-meta" + (ready.status === "configured" ? " ok" : ""), ready.short));
        list.append(row); rows.push(row);
      }
      const hidden = agents.length - open.length;
      lead = "沿用所选 Agent 在本机的登录、模型和推理强度，创建后可在详情里更换。" + (hidden ? `另有 ${hidden} 个 Agent 暂不能选用，可在设置 · 本地 Agent 查看原因。` : "");
      sync = roving(list, rows, pick);
      pick(rows.find(r => r._agent === preferred(open)) || rows[0]);
    }
    load(false);
    return { element: box, value: () => chosen };
  }

  const headline = agent => binding(agent).title;
  window.XBotAgents = {
    settings, unmount: () => teardown(), open, trigger, field, headline,
    // Pure projections of the /xbot-api/agents contract, shared with tests.
    model: { readiness, selectable, unavailable, preferred, activity, defaults, binding, unchanged, impact, bind, bindError, inventory },
  };
})();
