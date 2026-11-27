// 资料页与群 · 规则层：没有 DOM，也没有网络。profile.js 和测试共用。
// What goes in which tab of the info drawer, the words it uses, a group's
// member edit (PATCH /xbot-api/groups/:id {name?, add?, remove?}, docs/xbot-api.md)
// and how a refused request is said. A group's name follows the same rules as
// 新建群聊 (quick-create-rules.js, mirroring the server's own `groupTitle`),
// so that module loads first. Words shown here are everyday Chinese: 猫猫, the
// cat's name, 群聊; never the engine's own terms.
(function (root) {
  "use strict";

  const trim = (value) => String(value == null ? "" : value).trim();
  const han = (text) => /\p{Script=Han}/u.test(String(text || ""));
  // A server sentence is shown as it is only when it is everyday Chinese
  // (Agent is an everyday name since 2026-11-12; the engine's words are not).
  const plain = (text) => han(text) && !/(?<![\w-])bot\b|\bmodel\b|\bsession\b|\bthread\b|模型|原生|会话|线程/i.test(String(text));
  const key = (sel) => (sel && sel.id ? (sel.type === "group" ? "group:" : "bot:") + sel.id : "");

  // ---- tabs ----
  // A cat: 资料 (what it is for, the conversation actions, everything
  // technical folded under 高级), 文件, 记忆, 定时. A group: 成员 and 文件.
  const TABS = Object.freeze({
    bot: Object.freeze([["profile", "资料"], ["files", "文件"], ["memory", "记忆"], ["schedule", "定时"]]),
    group: Object.freeze([["members", "成员"], ["files", "文件"]]),
  });
  const tabs = (kind) => TABS[kind === "group" ? "group" : "bot"];
  const home = (kind) => tabs(kind)[0][0];
  // The tab the drawer opened at last may be one the other kind of chat does
  // not have, or one of the retired names (详情, 记忆 as library, 任务, 轨迹,
  // 上下文): each lands where its content now lives.
  const MOVED = Object.freeze({ details: "profile", library: "memory", computer: "profile", trace: "profile", context: "profile" });
  function tabFor(kind, wanted) {
    const list = tabs(kind);
    if (list.some(([id]) => id === wanted)) return wanted;
    const moved = Object.hasOwn(MOVED, wanted) ? MOVED[wanted] : "";
    return list.some(([id]) => id === moved) ? moved : list[0][0];
  }
  // 任务与执行 is in the home tab's folded 高级 now: the old 任务 tab opens it there.
  const opensAdvanced = (wanted) => wanted === "computer";

  // ---- a cat ----
  // The cat's own native colour pair, only as the server gives it (#rrggbb).
  const HEX = /^#[0-9a-f]{6}$/i;
  function accent(bot) {
    const a = bot && bot.accent;
    return a && HEX.test(String(a.primary)) && HEX.test(String(a.secondary)) ? { primary: a.primary, secondary: a.secondary } : null;
  }
  // A cat made from a name alone carries its own ID as its native breed (the
  // unpatched member creation files it as a new member): no breed to name, so
  // the 猫种 row is left out rather than showing that ID.
  function ownBreed(config, bot) {
    const id = config && config.breed && config.breed.mode === "explicit" ? config.breed.breedId : "";
    return !!id && !!bot && (id === bot.native_id || id === bot.id);
  }

  // ---- a group ----
  const MIN = 2, MAX = 10;
  // The members as the server lists them (cat names, or a native ID for a cat
  // it cannot find), each matched to a loaded cat; duplicates once.
  function members(group, cats) {
    const out = [], seen = new Set();
    for (const raw of Array.isArray(group && group.members) ? group.members : []) {
      const said = String(raw);
      const cat = (cats || []).find((c) => c && (c.name === said || c.native_id === said || c.id === said));
      const name = cat ? cat.name : said;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, known: !!cat });
    }
    return out;
  }
  const known = (group, cats) => members(group, cats).filter((m) => m.known).map((m) => m.name);
  const countText = (n) => n + " 只猫猫";
  // Cats not yet in the group, in the list's order.
  function addable(group, cats) {
    const inside = new Set(known(group, cats));
    return (cats || []).map((c) => c && c.name).filter((n) => n && !inside.has(n));
  }
  const room = (group, cats) => Math.max(0, MAX - known(group, cats).length);
  // One may leave while at least two stay (as far as this page knows; the
  // server checks the roster as it is now and refuses with its own words).
  const canRemove = (group, cats, name) => { const list = known(group, cats); return list.includes(name) && list.length - 1 >= MIN; };
  // A member edit says what the owner means — add these cats, take that one
  // out — never a whole list: the server applies it to the roster as it is
  // now, one edit at a time, so a page that has not caught up with a change
  // made elsewhere cannot undo it by sending what it last saw.
  const addBody = (names) => ({ add: [...new Set((names || []).map(trim).filter(Boolean))] });
  const removeBody = (name) => ({ remove: [trim(name)] });
  // The group the server answered with (its record after the edit), or null
  // when the answer is not one; the page shows that, not what it asked for.
  function groupFrom(answer, id) {
    if (!answer || typeof answer !== "object" || !Array.isArray(answer.members)) return null;
    if (answer.id && answer.id !== id) return null;
    return Object.assign({}, answer, { id: answer.id || id });
  }
  // A group's name: the 新建群聊 rule; cleared, it takes the members' names,
  // the name an unnamed group gets.
  const QC = () => root.ClowderQuickCreateRules;
  const defaultName = (group, cats) => QC().groupName(known(group, cats));
  const nameProblem = (name) => QC().groupNameProblem(name);
  const renameBody = (name, group, cats) => ({ name: trim(name) || defaultName(group, cats) });
  // A group name may be left empty (it then takes the members' names): told
  // to a screen reader, as on 新建's group side.
  const nameSaid = () => QC().GROUP_NAME_SAID;
  // A refused group change, in everyday words; a 409 is the server's own
  // sentence (a cat to remove still has work there: nothing is stopped here).
  function groupError(err, what) {
    const status = err && err.status, message = String((err && err.message) || "");
    if (!status || status >= 500) return { kind: "unsure", text: what === "delete" ? "没能确认群聊删掉没有。刷新列表看看。" : "没能确认改好没有。刷新后看看，再决定要不要重试。" };
    if (status === 409) return { kind: "busy", text: plain(message) ? message : "有猫猫还在这个群里处理事情，等它做完或先停止，再把它移出。" };
    if (status === 404) return /猫猫/.test(message) ? { kind: "gone", text: "有只猫猫找不到了，刷新列表后再试。" } : { kind: "gone", text: "找不到这个群聊了，刷新列表看看。" };
    return { kind: "form", text: plain(message) ? message : what === "delete" ? "没能删掉群聊，请稍后再试。" : "没能改好，请稍后再试。" };
  }

  // ---- 这台电脑 (item 52) ----
  // GET /xbot-api/bots/:name/computer → {supported, installed, on, permissions,
  // missing?, others?}; PUT {enabled} answers with the same view as it is afterwards
  // (docs/xbot-api.md「这台电脑」). `on` is the engine's record, read every time:
  // the page draws the last answer and asks again, never keeps it as the truth.
  // It is the owner's own machine: 「这台电脑」, never a computer of the cat's.
  // One cat at a time (item 55): `others` names the other cats that have it on,
  // and one already off whose turn that had it is still going (item 56); turning
  // this one on switches them off first, ending a reply they are writing.
  const COMPUTER = Object.freeze({
    TITLE: "可以用这台电脑",
    INSTALL: "npm run computer:install",
    OPENING: "正在打开…",
    CLOSING: "正在关掉…",
    // Off also ends the reply the cat is in the middle of (it keeps the tools it started with): said while that takes.
    CLOSING_REPLY: "正在关掉，它正在写的回复会停下…",
    WAITING: "等你在系统设置里打开…",
    // On where this system has no driver (the switch came along with the data from a Mac): it can only be switched off.
    UNSUPPORTED: "现在还用不了：这个系统还不能让猫猫操作电脑。",
    STOP: "不等了",
    YES: "打开",
  });
  const GRANTS = Object.freeze(["accessibility", "screen_recording"]);
  // The view, taken only in its own shape; anything else is no view, and the
  // page then says nothing about the computer rather than something false.
  // A grant said to be missing without a name it knows counts as both. The
  // other cats only as a non-empty list of names ('' for one the server could
  // not name); anything else is none.
  function computerView(answer) {
    const a = answer && typeof answer === "object" ? answer : null;
    if (!a || typeof a.supported !== "boolean" || typeof a.installed !== "boolean" || typeof a.on !== "boolean") return null;
    const permissions = ["granted", "needed", "unknown"].includes(a.permissions) ? a.permissions : "unknown";
    const named = permissions === "needed" && Array.isArray(a.missing) ? GRANTS.filter((g) => a.missing.includes(g)) : [];
    const others = Array.isArray(a.others) && a.others.length && a.others.every((n) => typeof n === "string") ? a.others.map(trim) : [];
    return { supported: a.supported, installed: a.installed, on: a.on, permissions, missing: permissions === "needed" ? (named.length ? named : [...GRANTS]) : [], others };
  }
  // Turning on came back unswitched because macOS has not given the driver
  // its grants yet (the driver has opened System Settings itself): the page
  // waits and sends the same request again once they are there.
  const waitsForGrant = (view) => !!view && view.supported && view.installed && !view.on && view.permissions === "needed";
  // The grants by the names System Settings lists them under, for CuaDriver
  // (the name macOS shows for the driver). Accessibility is 辅助功能; newer
  // systems list it as 设备控制与数据访问, so both names are given.
  const GRANT_WORDS = Object.freeze({ accessibility: "「辅助功能」（或「设备控制与数据访问」）", screen_recording: "「屏幕录制」" });
  const grantPlace = (missing) => "到系统设置 › 隐私与安全性，在" + (missing && missing.length ? missing : GRANTS).map((g) => GRANT_WORDS[g]).join("和") + "里打开 CuaDriver";
  // What turning it on means, asked every time it is turned on: what the cat
  // can do and where what it sees goes. 模型 is the one technical word here,
  // and it is the consequence the owner decides on (tests/vocabulary.test.ts).
  // With other cats on (the view's `others`), who gives it up: `handover`,
  // else "" and the dialog is as it always was.
  function computerConsent(name, others) {
    return {
      title: "让「" + (trim(name) || "这只猫猫") + "」用这台电脑？",
      text: "它能看到并操作这台电脑上的应用，看到的画面会发给它用的模型。",
      handover: computerHandover(others),
    };
  }
  // The cats the server named, each in 「」 (one name once); those it could
  // not name as 另一只猫, or 另外几只猫 for more than one.
  function computerHandover(others) {
    const list = Array.isArray(others) ? others.map(trim) : [];
    if (!list.length) return "";
    const names = [...new Set(list.filter(Boolean))].map((n) => "「" + n + "」");
    const unnamed = list.filter((n) => !n).length;
    const rest = unnamed > 1 ? "另外几只猫" : unnamed ? "另一只猫" : "";
    const who = names.join("") + (names.length && rest ? "和" : "") + rest;
    const one = names.length + unnamed === 1;
    return "同一时间只有一只猫能用这台电脑：打开后，" + who + "的会关掉；" + (one ? "它要是正在回复，那条回复会停下。" : "它们要是正在回复，那些回复会停下。");
  }
  // The cats a turn on would take the computer from now (a view's `others`)
  // that the dialog the owner confirmed did not name (`told`, the list it was
  // drawn from): a name it said covers that cat; one the server could not
  // name ('') only as many times as the dialog counted one (item 57).
  function computerUntold(told, others) {
    const said = Array.isArray(told) ? told.map(trim) : [], out = [];
    for (const n of Array.isArray(others) ? others.map(trim) : []) {
      const at = said.indexOf(n);
      if (at < 0) out.push(n);
      else if (!n) said.splice(at, 1);
    }
    return out;
  }
  // A change that did not go through: the server's own sentence when it is
  // everyday words (computer_half_registered asks the owner to check every
  // cat, so it is shown whole; computer_other_on / computer_other_running /
  // computer_not_on / computer_on_unknown name the other cat), else what did
  // not happen. A cat's name in 「」 is the owner's own word: it does not make
  // the sentence technical.
  function computerError(err, enabling) {
    const message = trim(err && err.message);
    if (err instanceof TypeError || message === "连不上 clowder-bot") return "连不上 clowder-bot";
    return plain(message.replace(/「[^「」]*」/g, "")) ? message : enabling ? "没能打开，请再试一次。" : "没能关掉，请再试一次。";
  }
  // The row as it is drawn, from the last view and what this page is doing
  // for the cat: busy "on" | "off" while a change is on its way (ending: the
  // cat was replying when off was asked, and that reply is being ended), wait
  // {missing} while turning on waits for a grant, said {text, code} the last
  // change that failed. The switch shows `on` as the server last said it,
  // never what was asked for. Lines only where something is wrong or pending:
  //   note   what is true and needs the owner (with the install command, or 不等了)
  //   error  the failed change (left out where the note already says it)
  // spin: a request is on its way (it can take seconds), as opposed to the
  // wait, which is the owner's to end. No driver for this system: nothing,
  // unless the cat is on (then it is there to be switched off).
  function computerRow(view, flow) {
    const f = flow || {};
    if (!view || (!view.supported && !view.on)) return { shown: false };
    const on = view.on, waiting = !!f.wait && !on;
    const out = { shown: true, on, busy: !!f.busy || waiting, spin: !!f.busy, can: !f.busy && !waiting && (on || (view.supported && view.installed)),
      hint: f.busy === "on" ? COMPUTER.OPENING : f.busy === "off" ? (f.ending ? COMPUTER.CLOSING_REPLY : COMPUTER.CLOSING) : waiting ? COMPUTER.WAITING : "", note: null, error: "" };
    if (!view.supported) out.note = { text: COMPUTER.UNSUPPORTED };
    else if (waiting && view.installed) out.note = { text: grantPlace(f.wait.missing) + "。", stop: true };
    else if (!view.installed) out.note = { text: (on ? "现在还用不了：找不到操作电脑用的驱动，" : "还没装上操作电脑用的驱动，") + "在 clowder-bot 目录里运行：", command: COMPUTER.INSTALL };
    else if (on && view.permissions === "needed") out.note = { text: "现在还用不了：" + grantPlace(view.missing) + "。" };
    if (f.said && f.said.text && !(f.said.code === "computer_absent" && !view.installed)) out.error = f.said.text;
    return out;
  }

  root.ClowderProfileRules = Object.freeze({
    trim, plain, key, TABS, tabs, home, tabFor, opensAdvanced,
    accent, ownBreed,
    MIN, MAX, members, known, countText, addable, room, canRemove, addBody, removeBody, groupFrom,
    defaultName, nameProblem, renameBody, nameSaid, groupError,
    COMPUTER, GRANTS, computerView, waitsForGrant, grantPlace, computerConsent, computerHandover, computerUntold, computerError, computerRow,
  });
})(typeof window !== "undefined" ? window : globalThis);
