// 开箱即用 · 规则层：没有 DOM，也没有网络。quick-create.js 和测试共用。
// The first-run stage and the quick 新建猫猫 / 新建群聊 dialogs read
// GET /xbot-api/start and send POST /xbot-api/bots {name, simple, idempotencyKey}
// and POST /xbot-api/groups {members, name?} (docs/xbot-api.md「开箱即用」).
// The name rules mirror the server's own (server/xbot/core.ts `label` and
// `groupTitle`, server/native/text.ts `clip`), so what the form accepts is
// what the adapter accepts. Words shown here never name models (an Agent is
// named by its own name, or called an Agent since 2026-11-12);
// what a face's cat is like is the engine's own template words, shown as
// they are (they may say Review or provider: that is the template, not us).
(function (root) {
  "use strict";

  const trim = (value) => String(value == null ? "" : value).trim();
  const han = (text) => /\p{Script=Han}/u.test(String(text || ""));
  // A server sentence is shown only when it is everyday Chinese: some adapter
  // messages name the Bot or the model, which this flow never does (the
  // product name clowder-bot is fine). Agent is what these programs are
  // called (since 2026-11-12), so it alone does not hide a sentence.
  const plain = (text) => han(text) && !/(?<![\w-])bot\b|\bmodel\b|模型/i.test(String(text));
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
  // A custom cat's personality: at most 500 characters (server `simpleCat.personality`).
  const PERSONALITY_INPUT_MAX = 1000;
  const personalityProblem = (text) => (length(trim(text)) > 500 ? "性格最多 500 个字" : "");
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
  // The name a face's cat comes with, made free among the taken names: the
  // template's own nickname (faces[] in /start: 宪宪, 砚砚…), else the
  // portrait library's (cat-avatars.js). `list` is the offered faces (or the
  // presets): anything with an id and a nickname.
  function suggestName(faceId, list, taken) {
    const face = (list || []).find((p) => p && p.id === faceId);
    return face && face.nickname ? freeName(face.nickname, taken) : "";
  }
  // The name box follows the chosen face until the owner types a name of their
  // own; emptied again, it follows once more. Whether the owner typed is the
  // box's input event (quick-create.js), never guessed from what the box holds:
  // a name typed by hand may well equal a cat's own (item 44, review).

  // ---- what each face's cat is like ----
  // Picking a face picks a cat: by default it starts with the engine's template
  // of the same id, which /start lists as faces[] (role, personality, strengths,
  // one clipped line each). The faces offered are those, in that order, that
  // have a portrait here; the label next to a portrait stays the client's own
  // (upstream calls dsh 小鲸鱼). With no faces (the templates could not be
  // read) every portrait is offered without words, and a cat of the owner's own
  // can still be made.
  // Each offered face keeps its `rev` (which version of the portrait the hint
  // shows), sent back with a creation from that face, the name its cat comes
  // with (`nickname`) and the tool it thinks with (`tool`, see toolOf; null
  // when the server did not say).
  function offer(faces, presets) {
    const own = new Map((presets || []).filter((p) => p && p.id).map((p) => [p.id, p]));
    const out = [], seen = new Set();
    for (const face of faces || []) {
      const p = face && own.get(face.id);
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ id: p.id, label: p.label, rev: face.rev || "", hint: trait(face), nickname: face.nickname || p.nickname || "", tool: face.tool || null });
    }
    return out.length ? out : [...own.values()].map((p) => ({ id: p.id, label: p.label, rev: "", hint: null, nickname: p.nickname || "", tool: null }));
  }

  // ---- which tool a face's cat thinks with ----
  // That is part of the cat (its template), not something picked beside it
  // (the owner, 2026-11-12). faces[].tool: {label, state, usable, id?,
  // reason?, loginCommand?}. In an answer of that shape, a face whose tool is
  // missing or cannot be read is "not known" (UNREAD): not creatable as it is,
  // and said so plainly. Only an answer of the older shape — no face carries
  // `tool` at all, or no faces — is made with the usual tool, as such servers
  // did. null while nothing can be made.
  const UNREAD = Object.freeze({ label: "", state: "unread", usable: false, id: "", reason: "没能读到它用什么思考", loginCommand: "" });
  function toolOf(face, s) {
    if (face && face.tool) return face.tool;
    if (!s || !s.ready) return null;
    return { label: s.agent.label, state: s.agent.confirmed ? "ready" : "unknown", usable: true, id: s.agent.id, reason: "", loginCommand: loginCommand(s, s.agent.id) };
  }
  const faceUsable = (face, s) => { const t = toolOf(face, s); return !!(t && t.usable); };
  // The face chosen for the owner: the first whose cat can be brought home as
  // it is. null when none can (then only 自定义 makes a cat).
  function firstUsable(offered, s) {
    const face = (offered || []).find((f) => faceUsable(f, s));
    return face ? face.id : null;
  }
  // What a cat's Agent is, said the way a person would, for a screen reader
  // (on screen the card shows a mark: the Agent's name and, when it is not
  // usable here, its state in one word — item 45). One that is here:
  // 「它用这台电脑上的 Claude Code 来思考」. One that is not: which it needs
  // (「它要用 Gemini 来思考」), why (the server's `reason`, one sentence without a
  // stop), and that it cannot be had now.
  const USES = Object.freeze(["它用这台电脑上的 ", " 来思考"]);
  function uses(tool) {
    if (!tool) return null;
    if (tool.usable) return { usable: true, label: tool.label, text: USES[0] + tool.label + USES[1] };
    return { usable: false, label: tool.label, text: (tool.label ? "它要用 " + tool.label + " 来思考。" : "") + why(tool) };
  }
  // What the owner can do about a tool that is not usable here: log in (its
  // command, copyable) or install, then 重新检测. On screen the command and the
  // button say it; `text` is the same for a screen reader. A tool the app
  // cannot connect yet has nothing to re-detect: installing it would not
  // change that (null).
  function toolHelp(tool) {
    if (!tool || tool.usable) return null;
    if (tool.state === "login") return { text: tool.loginCommand ? "在终端里运行这行命令登录，再重新检测" : "登录后再重新检测", command: tool.loginCommand,
      unchanged: "重新检测过了，还是没检测到登录。" };
    if (tool.state === "missing") return { text: "装好 " + tool.label + " 并登录后再重新检测", command: "", unchanged: "重新检测过了，还是没找到 " + tool.label + "。" };
    return null;
  }
  const loginHelp = (command) => toolHelp({ state: "login", loginCommand: command }).text;
  // Why a cat cannot be had now: the server's reason (one sentence without a
  // stop). Said, never shown as a caption: the card's Agent mark shows it in
  // one word.
  const why = (tool) => (tool && !tool.usable ? tool.reason + "，现在领不了。" : "");
  // The one word for an Agent's state on a cat's Agent mark, true to what the
  // server named and in the product's usual words: 暂不支持 (this app cannot
  // connect it: nothing to install), 未安装, 未登录, 未知 (could not be read);
  // installed with a login that could not be checked: 未确认登录.
  const TAGS = Object.freeze({ unsupported: "暂不支持", missing: "未安装", login: "未登录", unread: "未知", unknown: "未确认登录" });
  const tag = (tool) => (!tool ? "" : tool.usable ? (tool.state === "unknown" ? TAGS.unknown : "") : TAGS[tool.state] || TAGS.unsupported);
  // The way on from a cat that cannot be had now: 自定义 with its looks
  // (BORROW on the button; BORROW_SAID its name for a screen reader), thinking
  // with an Agent that is here (forward: named when there is one).
  const BORROW = "自定义";
  const BORROW_SAID = "用它的长相自定义";
  function forward(s) {
    const list = choices(s);
    return "用这台电脑上的 " + (list.length === 1 ? list[0].label : "Agent") + " 来思考";
  }
  // Sentences said as one, a stop between them unless one is already there.
  const joinSaid = (parts) => parts.filter(Boolean).reduce((all, part) => (!all ? part : all + (/[。！？.!?…]$/u.test(all) ? "" : "。") + part), "");
  // Whether a cat can be made at all. The server needs a face's template even
  // for a custom cat (its colour), so when /start says it read none this
  // client can draw (faces is []), creation would only be refused: the
  // screens say so instead of offering it. A server that sends no faces at
  // all (null: older than faces[]) is not second-guessed.
  function usable(faces, presets) {
    if (faces == null) return true;
    const own = new Set((presets || []).filter((p) => p && p.id).map((p) => p.id));
    return faces.some((f) => f && own.has(f.id));
  }
  // What stands in the way when the cats' details cannot be read, in the
  // same shape as need() (item 28's blocked view, with 重新检测).
  function facesNeed() {
    return {
      kind: "faces",
      title: "暂时读不到猫猫的资料",
      body: "猫猫们的样子和性格现在读不出来，暂时建不了猫猫。",
      commands: [],
      unchanged: "重新检测过了，还是读不到猫猫的资料。",
    };
  }
  // One calm line, cut at a pause (、，；space) near the end when it is too
  // long, never mid-way through a word when a pause is close by. The card has
  // room for about two lines of each (CSS clamps what is left).
  const TRAIT_MAX = 60;
  function clipLine(value, max) {
    const text = trim(String(value == null ? "" : value).replace(/\s+/g, " "));
    const chars = [...text];
    if (chars.length <= max) return text;
    let cut = chars.slice(0, max - 1).join("");
    const pause = Math.max(...["、", "，", ",", "；", ";", "。", " ", "/"].map((p) => cut.lastIndexOf(p)));
    if (pause >= cut.length * 0.6) cut = cut.slice(0, pause);
    return cut.replace(/[\s、，,；;。/:：-]+$/u, "") + "…";
  }
  // What a cat is like, in at most two short lines for its card: its
  // personality (in its own words), then what it is good at (its strengths,
  // else its role), in the template's own words. `said` is the same, as one
  // sentence for a screen reader. null when the template says neither.
  function trait(face) {
    if (!face || typeof face !== "object") return null;
    const temper = clipLine(face.personality, TRAIT_MAX);
    const strengths = clipLine(face.strengths, TRAIT_MAX - 3);
    const good = strengths
      ? (strengths.startsWith("擅长") ? strengths : "擅长" + (/^[\x21-\x7e]/.test(strengths) ? " " : "") + strengths)
      : clipLine(face.role, TRAIT_MAX);
    const lines = [temper, good].filter(Boolean);
    if (!lines.length) return null;
    const said = lines.length > 1 ? lines[0] + (/[。！？.!?…]$/u.test(lines[0]) ? "" : "。") + lines[1] : lines[0];
    return { lines, said };
  }
  // 自定义, one of the options beside the cats: a cat of the owner's own. Its
  // card shows its looks, its Agent and two empty lines; this is said once
  // when it is chosen (a screen reader; nothing on screen needs it).
  const OWN_NOTE = "自定义：挑一个长相，它做什么、什么性格由你来写，都可以不填。";
  // The name box's placeholder: a cat of the owner's own borrows no template's
  // name, so its box starts empty and asks for one.
  const NAME_PLACEHOLDER = "给它起个名字";
  // 自定义's two optional lines: the question each answers is its placeholder
  // (and its name), with nothing beside it.
  const ABOUT_ASK = "它主要帮你做什么";
  const PERSONALITY_ASK = "它的性格";
  // Which boxes may stay empty, told to a screen reader only (a description;
  // the name, which must be filled, is aria-required). On screen an empty
  // line costs nothing, and the group name's grey text is the real default.
  const OPTIONAL_SAID = "可不填";
  const GROUP_NAME_SAID = "可不填，不填就用成员的名字";

  // ---- GET /xbot-api/start ----
  const STATES = ["ready", "unknown", "login", "missing"];
  // A face's tool, read defensively. `usable` is the server's word for
  // "a cat can be made from this face as it is"; anything else is not usable
  // and says why (`reason`, without its stop; a plain fallback when missing).
  function faceTool(t) {
    if (!t || typeof t !== "object") return null;
    const label = trim(t.label);
    if (!label) return null;
    const usable = t.usable === true;
    const state = usable ? (t.state === "ready" ? "ready" : "unknown")
      : ["login", "missing", "unsupported"].includes(t.state) ? t.state : "unsupported";
    const reason = usable ? "" : trim(t.reason).replace(/[。.\s]+$/u, "") || label + " 现在用不了";
    return { label, state, usable, id: usable && typeof t.id === "string" ? trim(t.id) : "", reason, loginCommand: trim(t.loginCommand) };
  }
  function start(raw) {
    raw = raw && typeof raw === "object" ? raw : {};
    const agents = (Array.isArray(raw.agents) ? raw.agents : [])
      .filter((a) => a && typeof a.id === "string" && a.id)
      .map((a) => ({ id: a.id, label: trim(a.label) || a.id, state: STATES.includes(a.state) ? a.state : "unknown", loginCommand: trim(a.loginCommand) }));
    const chosen = raw.agent && typeof raw.agent.id === "string" && raw.agent.id
      ? { id: raw.agent.id, label: trim(raw.agent.label) || raw.agent.id, confirmed: raw.agent.confirmed === true } : null;
    const ready = raw.ready === true && !!chosen;
    // faces[]: {id, rev, name?, nickname?, role?, personality?, strengths?,
    // tool}; [] when the templates could not be read; null when the server
    // sends no faces at all. When any face carries `tool`, the answer has
    // that shape, and a face whose tool is missing or malformed is UNREAD;
    // when none does, it is the older shape (no tool on any face).
    const toolShaped = Array.isArray(raw.faces) && raw.faces.some((f) => f && typeof f === "object" && "tool" in f);
    const faces = !Array.isArray(raw.faces) ? null : raw.faces
      .filter((f) => f && typeof f.id === "string" && f.id)
      .map((f) => {
        const face = { id: f.id };
        for (const k of ["rev", "name", "nickname", "role", "personality", "strengths"]) if (typeof f[k] === "string" && trim(f[k])) face[k] = trim(f[k]);
        const tool = faceTool(f.tool) || (toolShaped ? UNREAD : null);
        if (tool) face.tool = tool;
        return face;
      });
    return {
      cats: Number.isFinite(raw.cats) ? raw.cats : 0, ready,
      agent: ready ? chosen : null,
      blocked: ready ? null : raw.blocked === "login_required" ? "login_required" : "no_agent",
      agents, faces,
    };
  }
  // The tools a cat of the owner's own (自定义) may think with: the server's
  // choice first, then every other one the adapter accepts now (logged in, or
  // installed with a login it could not check). Tools that need a login or are
  // missing are not offered. A face's own cat has its own tool (toolOf).
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
  // Whether a cat's card would show its tool the same: its name, its state,
  // whether it can come home (which group its tile is in) and its command.
  const sameTool = (a, b) => {
    const sig = (t) => (t ? [t.label, t.state, !!t.usable, t.loginCommand || ""].join("|") : "");
    return sig(a) === sig(b);
  };
  // Re-detecting changed nothing the owner could see (the tools, which faces
  // could be read, and what each face's tool is like here).
  function sameStart(a, b) {
    const sig = (s) => [s.ready, s.blocked, s.agent && s.agent.id, s.agent && s.agent.confirmed, ...s.agents.map((x) => x.id + ":" + x.state),
      s.faces ? "faces:" + s.faces.map((f) => f.id + (f.tool ? ":" + f.tool.label + ":" + f.tool.state + ":" + f.tool.usable : "")).join(",") : "faces?"].join("|");
    return !!a && !!b && sig(a) === sig(b);
  }
  const joinOr = (labels) => (labels.length <= 1 ? labels[0] || "" : labels.slice(0, -1).join("、") + " 或 " + labels[labels.length - 1]);

  // What stands in the way, in everyday words, with the native login commands
  // (重新检测 is the button under it, and each command chip carries a
  // terminal's mark: the words point at neither).
  function need(s) {
    const tools = s && s.blocked === "login_required" ? s.agents.filter((a) => a.state === "login") : [];
    if (tools.length) {
      const names = joinOr(tools.map((a) => a.label));
      return {
        kind: "login",
        title: "还差一步：登录 " + names,
        body: "猫猫要借这台电脑上的 " + names + " 来思考，可" + (tools.length > 1 ? "它们都" : "它") + "还没登录。",
        commands: tools.filter((a) => a.loginCommand).map((a) => ({ label: a.label, command: a.loginCommand })),
        // Said before the commands (a screen reader); on screen each chip's terminal mark says it.
        run: tools.some((a) => a.loginCommand) ? "在终端里运行" + (tools.length > 1 ? "其中一行" : "下面这行") + "：" : "",
        unchanged: "重新检测过了，还是没检测到登录。",
      };
    }
    return {
      kind: "none",
      title: "还差一步：装好 Claude Code 或 Codex",
      body: "猫猫要借这台电脑上的 Claude Code 或 Codex 来思考，装好其中一个并登录。",
      commands: [],
      unchanged: "重新检测过了，还是没找到能用的。",
    };
  }
  // 自定义's Agent mark is said as 「它会用这台电脑上的 X 来思考」 around the
  // tool's name (or its select); the sentence is for a screen reader.
  const TOOL_LINE = Object.freeze(["它会用这台电脑上的 ", " 来思考"]);
  // Installed, but its login could not be checked: say so, never "ready".
  function unconfirmed(label, command) {
    return command ? "没能确认 " + label + " 已经登录。还没登录的话，先在终端里运行：" : "没能确认 " + label + " 已经登录，没登录的话它回不了话。";
  }

  // ---- request bodies ----
  // A face's own cat sends only the face: its tool is part of it (the server
  // binds the face's own and refuses another, face_tool), and words of the
  // owner's own would silently make it custom on the server, so they go only
  // with `custom: true`, and then only what was written (empty is a plain
  // helper). A face's own cat carries the `rev` of the portrait the owner was
  // shown, so the server makes that cat or says it changed (face_changed); a
  // custom cat takes only the looks and has no portrait to compare. A custom
  // cat always sends the tool shown, so a retry is the same request.
  function catBody({ name, face, rev, agent, custom, about, personality }) {
    const simple = {};
    if (face) simple.face = face;
    if (!custom && face && rev) simple.rev = rev;
    if (custom) {
      simple.custom = true;
      const what = trim(about), temper = trim(personality);
      if (what) simple.about = what;
      if (temper) simple.personality = temper;
      if (agent) simple.agent = agent;
    }
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
  // A failed POST /xbot-api/bots: which part of the form answers it. A 409 is
  // the name only when the server says so (name_taken). No status or a 5xx is
  // unsure: the cat may exist, and the same request again returns it rather
  // than a second one.
  // Two refusals the server names by code, before it asks the engine for
  // anything (so neither is unsure, and neither is the name): face_changed —
  // the portrait changed since the screen read it, so the screen reads it
  // again and the owner has another look; faces_unavailable — the cats'
  // details could not be read, so nothing was made.
  // Two more, also before anything is made: face_unavailable — this face's
  // tool cannot be used here (the screen may have shown it as it was before),
  // and face_tool — another tool was sent for a face's own cat. Both are said
  // in the server's own sentence (it says what would help), and the screen
  // reads /start again.
  const FACE_CHANGED = "这只猫猫的介绍刚刚更新了，再看一眼，合适就再点一次。";
  function catError(err, name, tool) {
    const status = err && err.status, message = String((err && err.message) || ""), code = err && err.code;
    if (code === "face_changed") return { kind: "changed", text: FACE_CHANGED };
    if (code === "faces_unavailable") return { kind: "unavailable", text: "刚才没能读到猫猫的资料，这次没有建。" };
    const said = message.replace(/\s+/g, " ").trim(), sentence = plain(said) ? said + (/[。！？]$/u.test(said) ? "" : "。") : "";
    if (code === "face_unavailable" || code === "face_tool") return { kind: "face", text: sentence || "刚才没能建好：" + (trim(tool) || "这个 Agent") + " 现在用不了。" };
    // The two 409s, told apart by code: the name is taken (said on the name),
    // or this key already stood for another request (the server's sentence,
    // not blamed on the name; the next attempt is a new request). A 409 with
    // neither code is said as the server said it, without guessing.
    if (code === "name_taken") return { kind: "name", text: trim(name) ? "已经有一只叫「" + trim(name) + "」的猫猫了，换个名字吧" : "已经有一只叫这个名字的猫猫了，换个名字吧" };
    if (code === "request_changed") return { kind: "changedRequest", text: sentence || "这次创建和上一次的内容不一样，没有建，请重新创建。" };
    if (status === 409) return { kind: "form", text: sentence || "没能建好，请稍后再试。" };
    if (status === 422) return { kind: "blocked", text: "刚才没能建好：" + (trim(tool) || "这个 Agent") + " 现在用不了。" };
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
    trim, nameProblem, groupNameProblem, groupName, freeName, suggestName, NAME_INPUT_MAX, ABOUT_INPUT_MAX, aboutProblem,
    PERSONALITY_INPUT_MAX, personalityProblem, offer, usable, facesNeed, trait, clipLine, TRAIT_MAX, OWN_NOTE, NAME_PLACEHOLDER, ABOUT_ASK, PERSONALITY_ASK, FACE_CHANGED,
    toolOf, faceUsable, firstUsable, uses, USES, UNREAD, why, tag, TAGS, toolHelp, loginHelp, BORROW, BORROW_SAID, forward, joinSaid, sameTool,
    OPTIONAL_SAID, GROUP_NAME_SAID,
    start, choices, choiceOf, loginCommand, sameStart, need, TOOL_LINE, unconfirmed,
    catBody, groupBody, fingerprint, MAX_MEMBERS, catError, groupError, startError, createdNotice,
  });
})(typeof window !== "undefined" ? window : globalThis);
