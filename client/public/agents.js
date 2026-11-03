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
    return parts.length ? parts.join(" · ") : "未读取到";
  }
  // The Bot's side (panel `agent`, plus the `cat_config` copied into it at
  // creation for its own effort). A managed account or any other native
  // carrier is kept read-only and never shown as a connected local Agent.
  function binding(agent, config) {
    if (!agent) return { local: false, legacy: false, id: null, title: "未读取", detail: "", override: "", effort: "" };
    const override = agent.modelOverride || "";
    const own = config && config.effort && config.effort.mode === "explicit" && typeof config.effort.value === "string" ? config.effort.value.trim() : "";
    if (!agent.id || agent.configurationSource !== "native_tool") {
      return { local: false, legacy: true, id: null, title: agent.label || "其他原生接入", detail: "原有接入，只读保留" + (override ? " · " + override : ""), override, effort: own };
    }
    const set = [override, own ? "推理强度 " + own : ""].filter(Boolean).join(" · ");
    const detail = set ? "Bot 单独指定 " + set : "沿用本机默认" + (agent.configuredModel ? " · " + agent.configuredModel : "");
    return { local: true, legacy: false, id: agent.id, title: agent.label || agent.id, detail, override, effort: own };
  }
  // Choosing the current Agent again only matters when it clears something the Bot set itself.
  function unchanged(view, agent) { return !!agent && view.local && view.id === agent.id && !view.override && !view.effort; }
  // PUT /bots/:name/agent drops the Bot's own carrier, model and effort. Say so
  // in one line, and only when there is something of the Bot's own to drop.
  function impact(view) {
    const cleared = [];
    if (view.legacy) cleared.push("原有接入");
    if (view.override) cleared.push("单独指定的模型 " + view.override);
    if (view.effort) cleared.push("单独指定的推理强度 " + view.effort);
    return cleared.length ? "确认后会清除" + cleared.join("、") + "。" : "";
  }
  function bind(api, bot, runtimeId) {
    return api("/xbot-api/bots/" + encodeURIComponent(bot) + "/agent", { method: "PUT", body: { runtimeId } });
  }
  // The server's own words come first: a 409 may mean work in flight or a
  // member edited elsewhere, so an unexplained one is only called a conflict.
  function bindError(err, bot) {
    const message = String((err && err.message) || "");
    if (/[㐀-鿿]/.test(message)) return message;
    if (err && err.status === 409) return `「${bot}」的配置刚有变化，请重新打开后再试。`;
    return "没能更换 Agent，请稍后再试。";
  }
  async function inventory(api, refresh = false) {
    const data = await api("/xbot-api/agents" + (refresh ? "?refresh=1" : ""));
    return { agents: Array.isArray(data && data.agents) ? data.agents : [], checkedAt: (data && data.checkedAt) || null };
  }
  const clock = ms => new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const when = ms => new Date(ms).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

  // 设置 · 本地 Agent groups on installation, the one fact discovery proves by
  // itself; login evidence and Bot-session activity stay separate facts.
  const found = agent => !!agent && agent.installed === true && readiness(agent).status !== "not_installed";
  const botNames = agent => ((agent && agent.bots) || []).map(b => b && b.name).filter(Boolean);
  // The row's one line. Idle goes unsaid (an Agent that is not installed also
  // reports 0 and 0); unknown is said wherever Bots would make it matter.
  function summary(agent) {
    if (!found(agent)) return "未检测到";
    if (agent.supported !== true) return "暂未适配";
    const a = agent.activity || {}, bots = botNames(agent).length, parts = [readiness(agent).short];
    if (bots) parts.push(bots + " 个 Bot");
    if (a.state === "running" || a.queued > 0) parts.push(activity(agent));
    else if (bots && a.state !== "idle") parts.push("会话状态未知");
    return parts.join(" · ");
  }
  // A brand mark only where the runtime id and its client agree (the pairs the
  // server adapts); any other Agent gets the shared Agent glyph.
  const MARKS = { codex: ["openai", "oa"], claude: ["anthropic", "cl"], kimi: ["kimi", "agent-kimi"] };
  function mark(agent) {
    const pair = agent && Object.hasOwn(MARKS, agent.id) ? MARKS[agent.id] : null;
    const ico = node("span", "bico agent-ico " + (pair && pair[0] === agent.clientId ? pair[1] : "ag"));
    ico.setAttribute("aria-hidden", "true");
    return ico;
  }
  function loginHint(agent) {
    const command = agent.readiness && agent.readiness.loginCommand, hint = node("p", "agent-hint");
    if (!command) { hint.textContent = "在终端完成登录后重新检测"; return hint; }
    hint.append("在终端运行 ", node("code", "", command), " 后重新检测");
    return hint;
  }
  function fact(label, value) {
    const row = node("div", "setrow agent-fact"), tx = node("div", "tx"), val = node("span", "agent-val");
    tx.append(node("b", "", label));
    val.append(...(Array.isArray(value) ? value : [value]));
    row.append(tx, val);
    return row;
  }
  function facts(list) {
    const box = node("div", "setrows agent-facts-list");
    for (const [label, value] of list) box.append(fact(label, value));
    return box;
  }
  function section(title, ...children) {
    const sec = node("div", "setsec");
    sec.append(node("h4", "", title), ...children);
    return sec;
  }

  let teardown = () => {};
  // A searchable list grouped by installation, one status line per Agent;
  // defaults, paths and detection evidence live one level down. `onLevel`
  // names that level for the settings bar, whose back button returns here.
  async function settings({ api, host, isCurrent = () => true, onLevel = () => {} }) {
    teardown();
    let alive = true, busy = false, agents = null, query = "", openId = null, repaint = null;
    const current = () => alive && isCurrent();
    teardown = () => { alive = false; host.replaceChildren(); };
    host.className = "skills-settings agent-settings";
    const stamp = node("span", "agent-stamp"); stamp.setAttribute("role", "status");
    const again = button("btn", "重新检测", () => load(true));
    const error = node("p", "sk-error"); error.setAttribute("role", "alert"); error.hidden = true;
    const fail = text => { error.textContent = text || ""; error.hidden = !text; };
    const body = node("div", "sk-body");
    host.replaceChildren(body);
    const chev = () => { const c = node("span", "skchev"); c.setAttribute("aria-hidden", "true"); return c; };

    // ---- 一层：列表 ----
    function showList(from) {
      openId = null; onLevel(null);
      const head = node("div", "sethd"); head.append(node("h2", "", "本地 Agent"));
      const toolbar = node("div", "sktoolbar"); toolbar.setAttribute("role", "toolbar"); toolbar.setAttribute("aria-label", "本地 Agent 列表工具");
      const wrap = node("div", "sksearchwrap"), glyph = node("span", "sksic"); glyph.setAttribute("aria-hidden", "true");
      const search = node("input", "sksearch"); search.type = "search"; search.placeholder = "搜索 Agent"; search.setAttribute("aria-label", "搜索 Agent"); search.autocomplete = "off"; search.value = query;
      wrap.append(glyph, search);
      toolbar.append(stamp, wrap, again);
      const sections = node("div", "agent-sections"), rows = new Map();
      const empty = node("div", "sknone"); empty.append(node("p", "", "没有检测到 Agent"));
      const none = node("div", "sknone"); none.setAttribute("aria-live", "polite");
      none.append(node("p", "", "没有匹配的 Agent"), button("clearsrch", "清除搜索", () => { query = ""; search.value = ""; paint(); search.focus(); }));
      function item(agent) {
        const row = button("skrow agent-item", "", () => showDetail(agent.id)), tx = node("span", "tx");
        tx.append(node("b", "", agent.label || agent.id), node("span", "hint", summary(agent)));
        row.append(mark(agent), tx, chev());
        rows.set(agent.id, row);
        return row;
      }
      function paint() {
        const list = agents || [], q = query.trim().toLowerCase();
        const hits = q ? list.filter(a => [a.label, a.id].join(" ").toLowerCase().includes(q)) : list;
        sections.replaceChildren(); rows.clear();
        for (const [title, group] of [["已安装", hits.filter(found)], ["未安装", hits.filter(a => !found(a))]]) {
          if (!group.length) continue;
          const box = node("div", "sklist");
          for (const agent of group) box.append(item(agent));
          sections.append(section(title, box));
        }
        empty.hidden = !agents || agents.length > 0;
        none.hidden = !list.length || hits.length > 0;
      }
      search.oninput = () => { query = search.value; paint(); };
      repaint = paint; paint();
      body.replaceChildren(head, toolbar, error, sections, empty, none);
      const back = from != null && rows.get(from);
      if (back) back.focus();
    }

    // ---- 二层：一个 Agent ----
    function showDetail(id, focus = true) {
      const agent = (agents || []).find(a => a.id === id);
      if (!agent) { showList(); return; }
      openId = id; repaint = null;
      const name = agent.label || agent.id, ready = readiness(agent), installed = found(agent), bots = botNames(agent);
      onLevel({ title: name, backLabel: "本地 Agent", back: () => showList(id) });
      const back = button("setback", "", () => showList(id)); back.append(node("span", "skback-chev"), "本地 Agent");
      const head = node("div", "agent-dhead"), title = node("div", "skdetail-name agent-dname");
      title.tabIndex = -1; title.append(mark(agent), node("span", "", name));
      head.append(title, stamp, again);

      const status = [["本机", installed ? "已安装" : "未检测到"]];
      if (installed) status.push(["登录", [dot(ready.dot), ready.text]]);
      if (agent.supported !== true) status.push(["接入", "暂未适配"]);
      else if (installed) status.push(["选用", !selectable(agent) ? unavailable(agent) : ready.status === "configured" ? "可以选用" : "可以选用，未登录时执行会失败"]);
      if (installed && (bots.length || (agent.activity && agent.activity.state === "running"))) status.push(["Bot 会话", activity(agent)]);
      const parts = [back, head, error, section("状态", facts(status), ...(ready.status === "login_required" ? [loginHint(agent)] : []))];

      if (installed || bots.length) {
        const list = node("div", "setrows agent-bots");
        for (const bot of bots) list.append(node("div", "setrow", bot));
        if (!bots.length) list.append(node("div", "setrow agent-empty", "还没有"));
        parts.push(section(bots.length ? "接入的 Bot · " + bots.length : "接入的 Bot", list));
      }
      if (installed) parts.push(section("本机默认", facts([["模型", agent.configuredModel || "未读取到"], ["推理强度", agent.configuredEffort || "未读取到"]])));

      const code = text => node("code", "", text), evidence = [], seen = agent.readiness || {};
      if (agent.command) evidence.push(["命令", code(agent.command)]);
      if (agent.transport) evidence.push(["接入方式", code(agent.transport)]);
      if (seen.loginCommand) evidence.push(["登录命令", code(seen.loginCommand)]);
      if (seen.checkedAt) evidence.push(["检测于", when(seen.checkedAt)]);
      evidence.push(["Agent ID", code(agent.id)]);
      const more = node("details", "agent-more"), link = node("p", "setfoot agent-runtime"), runtime = node("a", "", "在运行面板查看原生详情");
      runtime.href = "/runtime.html"; runtime.target = "_blank"; runtime.rel = "noopener";
      link.append(runtime);
      more.append(node("summary", "", "检测详情"), facts(evidence), link);
      parts.push(more);

      body.replaceChildren(...parts);
      if (!focus) return;
      const scroller = host.closest && host.closest(".setcnt");
      if (scroller) scroller.scrollTop = 0;
      title.focus({ preventScroll: true });
    }

    // Read-only: ?refresh=1 goes out only when 重新检测 is pressed.
    async function load(refresh) {
      if (busy || !current()) return;
      const refocus = document.activeElement === again;
      busy = true; again.disabled = true; fail("");
      stamp.textContent = refresh ? "正在重新检测…" : "正在读取…";
      try {
        const data = await inventory(api, refresh);
        if (!current()) return;
        agents = data.agents;
        stamp.textContent = refresh && data.checkedAt ? "检测于 " + clock(data.checkedAt) : "";
        if (openId != null) showDetail(openId, false); else if (repaint) repaint(); else showList();
      } catch {
        if (!current()) return;
        stamp.textContent = "";
        fail("没能读取本地 Agent");
      } finally {
        busy = false;
        if (current()) {
          again.disabled = false;
          const now = document.activeElement;
          if (refocus && again.isConnected && (!now || now === document.body)) again.focus();
        }
      }
    }
    showList();
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
    const view = binding(data.agent, data.cat_config);
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
      note.textContent = use.disabled ? "" : impact(view) + (busy() ? "有任务在执行或排队，完成或停止后才能更换。" : "");
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
      if (agent) {
        data.agent = agent;
        // The switch dropped the Bot's own effort; the panel reload brings the rest.
        if (data.cat_config) data.cat_config = { ...data.cat_config, effort: { mode: "inherit" } };
      }
      paint();
      if (onBound) await onBound(agent, picked);
    } }));
    b.setAttribute("aria-haspopup", "dialog");
    const paint = () => {
      const view = binding(data.agent, data.cat_config), tx = node("span", "bt-tx");
      tx.append(node("strong", "bt-model agent-label" + (!data.agent ? " unset" : view.local ? "" : " legacy"), view.title));
      if (view.detail) tx.append(node("span", "bt-sub", view.detail));
      const chev = node("span", "skchev"); chev.setAttribute("aria-hidden", "true");
      b.replaceChildren(tx, ...(aside ? [aside] : []), chev);
      b.setAttribute("aria-label", `执行 Agent：${view.title}${view.detail ? "，" + view.detail : ""}，点按更换`);
    };
    paint();
    return b;
  }

  // 新建猫猫 picks its Agent in cat-templates.js; this module no longer has a create field.
  const headline = agent => binding(agent).title;
  window.XBotAgents = {
    settings, unmount: () => teardown(), open, trigger, headline,
    // Pure projections of the /xbot-api/agents contract, shared with tests.
    model: { readiness, selectable, unavailable, activity, defaults, binding, unchanged, impact, bind, bindError, inventory, installed: found, summary },
  };
})();
