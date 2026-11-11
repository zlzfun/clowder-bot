// 开箱即用 · 规则层：没有 DOM，也没有网络。quick-create.js 和测试共用。
// The first-run stage and the quick 新建猫猫 / 新建群聊 dialogs read
// GET /xbot-api/start and send POST /xbot-api/bots {name, simple, idempotencyKey}
// and POST /xbot-api/groups {members, name?} (docs/xbot-api.md「开箱即用」).
// The name rules mirror the server's own (server/xbot/core.ts `label` and
// `groupTitle`, server/native/text.ts `clip`), so what the form accepts is
// what the adapter accepts. Words shown here never name Agents or models.
(function (root) {
  "use strict";

  const trim = (value) => String(value == null ? "" : value).trim();
  const han = (text) => /\p{Script=Han}/u.test(String(text || ""));
  // A server sentence is shown only when it is everyday Chinese: some adapter
  // messages name the Bot or the Agent, which this flow never does (the
  // product name clowder-bot is fine).
  const plain = (text) => han(text) && !/\bagent\b|(?<![\w-])bot\b|\bmodel\b|模型/i.test(String(text));
  // zod counts a string's length in characters (code points), not UTF-16 units.
  const length = (text) => [...text].length;

  // ---- names ----
  // A cat's name is @-mentionable: zod trims, then wants 1–64 characters of
  // letters, digits, spaces and _ . - (server `label`). The duplicate check
  // ignores case, as the adapter's does.
  const CAT_NAME = /^[\p{L}\p{N}_ .-]+$/u;
  function nameProblem(name, taken) {
    const value = trim(name);
    if (!value) return "给它起个名字吧";
    if (length(value) > 64) return "名字最多 64 个字";
    if (!CAT_NAME.test(value)) return "名字只能用文字、数字、空格和 _ . -";
    const lower = value.toLowerCase();
    if ((taken || []).some((n) => trim(n).toLowerCase() === lower)) return "已经有一只叫「" + value + "」的猫猫了，换个名字吧";
    return "";
  }
  // A browser's maxlength counts UTF-16 units: every name the server accepts
  // (64 characters, each at most two units) fits in this many, and the rules
  // here say when one is too long.
  const NAME_INPUT_MAX = 128;
  // The optional line about what a cat mainly helps with: at most 2000
  // characters (server `simpleCat.about`), so its box admits twice that.
  const ABOUT_INPUT_MAX = 4000;
  const aboutProblem = (text) => (length(trim(text)) > 2000 ? "这一行最多 2000 个字" : "");
  // A group's name is a native thread title: free text, 1–64 after trimming,
  // no < > or control characters (server `groupTitle`). Empty is allowed: the
  // server then names the group after its members.
  const GROUP_NAME = /^[^<>\x00-\x1f\x7f]+$/;
  function groupNameProblem(name) {
    const value = trim(name);
    if (!value) return "";
    if (length(value) > 64) return "群名最多 64 个字";
    if (!GROUP_NAME.test(value)) return "群名里不能有 < > 这类符号";
    return "";
  }
  // The name an unnamed group gets: its members joined by 「、」, clipped to 64
  // with an ellipsis exactly as the server's clip() does.
  function groupName(members) {
    const joined = (members || []).map(trim).filter(Boolean).join("、");
    if (joined.length <= 64) return joined;
    let end = 63;
    const last = joined.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    return joined.slice(0, end) + "…";
  }
  // 宪宪, then 宪宪 2, 宪宪 3… when a cat already has the name.
  function freeName(base, taken) {
    const name = trim(base);
    const used = new Set((taken || []).map((n) => trim(n).toLowerCase()));
    if (!name || !used.has(name.toLowerCase())) return name;
    for (let i = 2; i < 100; i++) if (!used.has((name + " " + i).toLowerCase())) return name + " " + i;
    return name;
  }

  // ---- faces ----
  // The face that goes with a tool, as the adapter picks one when none is sent
  // (Claude Code → 布偶猫, Codex → 缅因猫, Kimi → 梵花猫); otherwise the first.
  const TOOL_FACE = Object.freeze({ claude: "ragdoll", codex: "maine-coon", kimi: "turkish-van" });
  function defaultFace(toolId, faces) {
    const list = faces || [];
    const own = TOOL_FACE[toolId];
    return own && list.includes(own) ? own : list[0] || null;
  }
  // A face's preset nickname (cat-avatars.js), made free among the taken names.
  function suggestName(faceId, presets, taken) {
    const preset = (presets || []).find((p) => p && p.id === faceId);
    return preset ? freeName(preset.nickname, taken) : "";
  }
  // The name box follows the chosen face until the owner types a name of their
  // own; emptied again, it follows once more.
  const followsFace = (value, suggested) => !trim(value) || value === suggested;

  // ---- GET /xbot-api/start ----
  const STATES = ["ready", "unknown", "login", "missing"];
  function start(raw) {
    raw = raw && typeof raw === "object" ? raw : {};
    const agents = (Array.isArray(raw.agents) ? raw.agents : [])
      .filter((a) => a && typeof a.id === "string" && a.id)
      .map((a) => ({ id: a.id, label: trim(a.label) || a.id, state: STATES.includes(a.state) ? a.state : "unknown", loginCommand: trim(a.loginCommand) }));
    const chosen = raw.agent && typeof raw.agent.id === "string" && raw.agent.id
      ? { id: raw.agent.id, label: trim(raw.agent.label) || raw.agent.id, confirmed: raw.agent.confirmed === true } : null;
    const ready = raw.ready === true && !!chosen;
    return {
      cats: Number.isFinite(raw.cats) ? raw.cats : 0, ready,
      agent: ready ? chosen : null,
      blocked: ready ? null : raw.blocked === "login_required" ? "login_required" : "no_agent",
      agents,
    };
  }
  // The tools a new cat may think with: the server's choice first, then every
  // other one the adapter accepts now (logged in, or installed with a login it
  // could not check). Tools that need a login or are missing are not offered.
  function choices(s) {
    if (!s || !s.ready) return [];
    const out = [{ id: s.agent.id, label: s.agent.label, confirmed: s.agent.confirmed }];
    for (const a of s.agents) {
      if (a.id === s.agent.id || (a.state !== "ready" && a.state !== "unknown")) continue;
      out.push({ id: a.id, label: a.label, confirmed: a.state === "ready" });
    }
    return out;
  }
  const choiceOf = (s, id) => choices(s).find((c) => c.id === id) || null;
  const loginCommand = (s, id) => ((s && s.agents.find((a) => a.id === id)) || {}).loginCommand || "";
  // Re-detecting changed nothing the owner could see.
  function sameStart(a, b) {
    const sig = (s) => [s.ready, s.blocked, s.agent && s.agent.id, s.agent && s.agent.confirmed, ...s.agents.map((x) => x.id + ":" + x.state)].join("|");
    return !!a && !!b && sig(a) === sig(b);
  }
  const joinOr = (labels) => (labels.length <= 1 ? labels[0] || "" : labels.slice(0, -1).join("、") + " 或 " + labels[labels.length - 1]);

  // What stands in the way, in everyday words, with the native login commands.
  function need(s) {
    const tools = s && s.blocked === "login_required" ? s.agents.filter((a) => a.state === "login") : [];
    if (tools.length) {
      const names = joinOr(tools.map((a) => a.label));
      return {
        kind: "login",
        title: "还差一步：登录 " + names,
        body: "猫猫要借这台电脑上的 " + names + " 来思考，可" + (tools.length > 1 ? "它们都" : "它") + "还没登录。"
          + (tools.some((a) => a.loginCommand) ? "在终端里运行" + (tools.length > 1 ? "其中一行" : "下面这行") + "，" : "") + "登录好再回来点「重新检测」。",
        commands: tools.filter((a) => a.loginCommand).map((a) => ({ label: a.label, command: a.loginCommand })),
        unchanged: "重新检测过了，还是没检测到登录。",
      };
    }
    return {
      kind: "none",
      title: "还差一步：装好 Claude Code 或 Codex",
      body: "猫猫要借这台电脑上的 Claude Code 或 Codex 来思考。装好其中一个并登录，再回来点「重新检测」。",
      commands: [],
      unchanged: "重新检测过了，还是没找到能用的。",
    };
  }
  // 「它会用这台电脑上的 X 来思考」 goes around the tool's name.
  const TOOL_LINE = Object.freeze(["它会用这台电脑上的 ", " 来思考"]);
  // Installed, but its login could not be checked: say so, never "ready".
  function unconfirmed(label, command) {
    return command ? "没能确认 " + label + " 已经登录。还没登录的话，先在终端里运行：" : "没能确认 " + label + " 已经登录，没登录的话它回不了话。";
  }

  // ---- request bodies ----
  // The tool shown is always sent, so a retry is the same request.
  function catBody({ name, face, agent, about }) {
    const simple = {};
    if (face) simple.face = face;
    const text = trim(about);
    if (text) simple.about = text;
    if (agent) simple.agent = agent;
    return { name: trim(name), simple };
  }
  function groupBody(members, name) {
    const title = trim(name);
    return title ? { members: [...members], name: title } : { members: [...members] };
  }
  function fingerprint(value) {
    if (Array.isArray(value)) return "[" + value.map(fingerprint).join(",") + "]";
    if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + fingerprint(value[k])).join(",") + "}";
    return JSON.stringify(value === undefined ? null : value);
  }

  // ---- answers ----
  const MAX_MEMBERS = 10;
  // A failed POST /xbot-api/bots: which part of the form answers it. A key is
  // only reused for the identical body, so a 409 here is the name. No status
  // or a 5xx is unsure: the cat may exist, and the same request again returns
  // it rather than a second one.
  function catError(err, name, tool) {
    const status = err && err.status, message = String((err && err.message) || "");
    if (status === 409) return { kind: "name", text: trim(name) ? "已经有一只叫「" + trim(name) + "」的猫猫了，换个名字吧" : "已经有一只叫这个名字的猫猫了，换个名字吧" };
    if (status === 422) return { kind: "blocked", text: "刚才没能建好：" + (trim(tool) || "这个工具") + " 现在用不了。" };
    if (!status || status >= 500) return { kind: "unsure", text: "没能确认猫猫建好没有。不改内容再点一次就好，不会多出一只。" };
    return { kind: "form", text: plain(message) ? message : "没能建好，请检查名字后再试。" };
  }
  // A created cat's `notice` (POST /xbot-api/bots 201, docs/xbot-api.md「开箱
  // 即用」): the cat exists, but one default setting could not be written. Said
  // once, quietly, after its chat opens; "" when there is nothing to say.
  function createdNotice(result) {
    return result && typeof result.notice === "string" ? result.notice.replace(/\s+/g, " ").trim() : "";
  }
  // A failed POST /xbot-api/groups. The request carries an idempotencyKey (it
  // names the group's directory and keys its native thread creation), so an
  // unsure answer is sent again unchanged under the same key and arrives at
  // the same group.
  function groupError(err) {
    const status = err && err.status, message = String((err && err.message) || "");
    if (!status || status >= 500) return { kind: "unsure", text: "没能确认群聊建好没有。不改内容再点一次就好，不会多出一个群。" };
    if (status === 404) return { kind: "form", text: "有只猫猫找不到了，刷新列表后再试。" };
    return { kind: "form", text: plain(message) ? message : "没能建群，请稍后再试。" };
  }
  const startError = (err) => (plain(err && err.message) ? String(err.message) : "没能读取这台电脑的情况");

  root.ClowderQuickCreateRules = Object.freeze({
    trim, nameProblem, groupNameProblem, groupName, freeName, defaultFace, suggestName, followsFace, NAME_INPUT_MAX, ABOUT_INPUT_MAX, aboutProblem,
    start, choices, choiceOf, loginCommand, sameStart, need, TOOL_LINE, unconfirmed,
    catBody, groupBody, fingerprint, MAX_MEMBERS, catError, groupError, startError, createdNotice,
  });
})(typeof window !== "undefined" ? window : globalThis);
