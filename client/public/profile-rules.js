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
  // Under 新对话 (whose dialog, refusals included, is chat-history.js's), what
  // happens to the conversation on screen.
  const NEW_CHAT_NOTE = "现在的对话会收进「历史对话」，随时能回去接着聊；它记得的关于你的事都还在。";

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
  // How to talk in a group: the engine's own routing (no @ → one cat answers;
  // @名字 → that one). The engine's @全体 means every cat the owner has, not
  // this group, so 「全体」 in the @ list mentions each member by name.
  const HOW_TO_TALK = "直接说，由一只猫猫接待；@名字 指定某一只；要大家都回答，就把每只都 @ 上（输入 @ 选「全体」）";
  // A refused group change, in everyday words; a 409 is the server's own
  // sentence (a cat to remove still has work there: nothing is stopped here).
  function groupError(err, what) {
    const status = err && err.status, message = String((err && err.message) || "");
    if (!status || status >= 500) return { kind: "unsure", text: what === "delete" ? "没能确认群聊删掉没有。刷新列表看看。" : "没能确认改好没有。刷新后看看，再决定要不要重试。" };
    if (status === 409) return { kind: "busy", text: plain(message) ? message : "有猫猫还在这个群里处理事情，等它做完或先停止，再把它移出。" };
    if (status === 404) return /猫猫/.test(message) ? { kind: "gone", text: "有只猫猫找不到了，刷新列表后再试。" } : { kind: "gone", text: "找不到这个群聊了，刷新列表看看。" };
    return { kind: "form", text: plain(message) ? message : what === "delete" ? "没能删掉群聊，请稍后再试。" : "没能改好，请稍后再试。" };
  }

  root.ClowderProfileRules = Object.freeze({
    trim, plain, key, TABS, tabs, home, tabFor, opensAdvanced,
    accent, ownBreed, NEW_CHAT_NOTE,
    MIN, MAX, members, known, countText, addable, room, canRemove, addBody, removeBody, groupFrom,
    defaultName, nameProblem, renameBody, HOW_TO_TALK, groupError,
  });
})(typeof window !== "undefined" ? window : globalThis);
