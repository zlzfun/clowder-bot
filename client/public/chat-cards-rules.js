// Rules for what a cat attaches to a reply, asks the owner to confirm, or
// leaves unfinished (classic script, window.ClowderCardsRules). No DOM and no
// network: chat-cards.js draws from these and tests load the same file.
//
// Everything here reads what the server projected (docs/chat-experience-api.md
// 「卡片、清单与选项」「等你确认的事」, docs/chat-live-api.md). A request card
// says only what the server has confirmed: an answer the owner gave is 已提交
// until the engine's receipt names the outcome, and a request that is no
// longer listed as open, with no receipt on the page, is only 已处理.
(() => {
  "use strict";
  const str = (v) => (typeof v === "string" ? v : "");
  const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const count = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
  const time = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? (v < 1e12 ? v * 1000 : v) : 0);
  const pad = (n) => String(n).padStart(2, "0");
  const han = (s) => /\p{Script=Han}/u.test(s);

  // ---- 等你确认的事 ----
  const KINDS = ["preference", "profile", "person", "schedule", "question", "other"];

  // GET <scope>/approvals, checked: the open requests of one conversation.
  // null when the answer is not such a list at all.
  function approvals(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.approvals)) return null;
    const action = (a) => (a && typeof a === "object" && oneLine(a.label) ? { label: oneLine(a.label) } : null);
    const list = [];
    for (const raw of data.approvals) {
      if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id || typeof raw.messageId !== "string") continue;
      if (raw.state != null && raw.state !== "open") continue;
      list.push({
        id: raw.id, kind: KINDS.includes(raw.kind) ? raw.kind : "other",
        title: oneLine(raw.title), body: str(raw.body).replace(/\r\n?/g, "\n").trim(), quote: oneLine(raw.quote),
        catId: str(raw.catId), catName: oneLine(raw.catName), messageId: raw.messageId,
        createdAt: time(raw.createdAt), expiresAt: time(raw.expiresAt),
        approve: action(raw.approve), reject: action(raw.reject), note: oneLine(raw.note),
      });
    }
    return { threadId: str(data.threadId), list };
  }

  // How an answered request turned out, from the engine's receipt (state),
  // said for what it was. A schedule request either sets a timer or removes
  // one; its title says which.
  const OUTCOME = {
    preference: ["已记住这个偏好", "没有记这个偏好"],
    profile: ["已更新关于你的资料", "没有更新关于你的资料"],
    person: ["已记下这个人", "没有记这个人"],
    schedule: ["已设好这个定时", "没有设这个定时"],
    unschedule: ["已取消这个定时", "这个定时还留着"],
    other: ["已同意", "已拒绝"],
  };
  function outcome(kind, state, title = "") {
    if (state === "closed") return "已结束";
    const words = OUTCOME[kind === "schedule" && /取消/.test(title) ? "unschedule" : kind] || OUTCOME.other;
    return state === "approved" ? words[0] : state === "rejected" ? words[1] : "已处理";
  }

  // A request in the chat's own words, from the best source at hand: the open
  // list's entry, else this page's last sight of it, else the row itself (the
  // server's card.approval: kind, a title without its subject, body). The
  // engine's own card title and Markdown body are never the words.
  function wording(approval, item, seen, catName) {
    const known = item || seen || null;
    if (known) return { kind: known.kind, title: known.title, body: oneLine(known.body), quote: known.quote || "" };
    const a = approval && typeof approval === "object" ? approval : {};
    const said = oneLine(a.title), who = oneLine(catName) || "猫猫";
    return { kind: KINDS.includes(a.kind) ? a.kind : "other", title: who + (said || "有件事等你确认"), body: oneLine(a.body), quote: "" };
  }

  // A request that is close to running out says so quietly; one that is not
  // says nothing. Never a countdown.
  function expiry(at, now) {
    if (!at || !now) return "";
    const left = at - now;
    if (left <= 0) return "已过了有效时间";
    if (left > 24 * 3600 * 1000) return "";
    const d = new Date(at), n = new Date(now);
    const day = d.toDateString() === n.toDateString() ? "今天" : "明天";
    return day + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + " 前有效";
  }

  // What a request card shows.
  //   fact:  the transcript's card block ({approval: {id, kind, title, body?, state?}});
  //   item:  the open request with that ID, or null when it is not listed;
  //   list:  how this conversation's open list stands: "idle" (not read yet),
  //          "loading", "ready", "error" or "missing" (no such route);
  //   seen:  the request as this page last listed it;
  //   local: the owner's answer from this page: {phase: "sending"|"sent"|"error",
  //          decision, settled (true|false|null), error: {text, detail}};
  //   fresh: the list was asked for after that answer;
  //   catName: who asked (the message's cat), now: the time.
  // mode "ask" is the card (its actions only ever from the open list; busy:
  // the answer being sent; waiting / note: why there are none); mode "line"
  // is one settled or neutral line.
  function card({ fact, item = null, list = "idle", seen = null, local = null, fresh = false, catName = "", now = 0 }) {
    const approval = fact && fact.approval ? fact.approval : {};
    const state = approval.state || "";
    const w = wording(approval, item, seen, catName);
    const line = (tone, text, icon, more = {}) => ({ mode: "line", kind: w.kind, tone, icon, text, what: w.body, runtime: false, ...more });
    if (state === "approved" || state === "rejected" || state === "closed") {
      return line(state === "approved" ? "ok" : state === "rejected" ? "no" : "exp", outcome(w.kind, state, w.title), state === "approved" ? "check" : state === "rejected" ? "x" : "clock");
    }
    const phase = local ? local.phase : "";
    if (phase === "sent") {
      // What the answer's own reply said, until a read made after it says more.
      if (fresh && list === "ready") {
        if (item) return line("neutral", "已提交，还在处理", "hourglass");
        return local.settled === true ? line("neutral", "已提交", "check") : line("neutral", "已处理", "circle-check");
      }
      if (local.settled === true) return line("neutral", "已提交", "check");
      if (local.settled === false) return line("neutral", "已提交，还在处理", "hourglass");
      return line("neutral", "没能确认结果，稍后会更新", "info");
    }
    // No longer open, and nothing on this page says how: neutral.
    if (list === "ready" && !item && phase !== "sending") return line("neutral", "已处理", "circle-check");
    const base = { mode: "ask", kind: w.kind, title: w.title, body: w.body, quote: w.quote, actions: [], busy: "", waiting: "", note: "", runtime: false, expiry: "", error: null };
    if (!item) {
      // Drawn from the row alone, without actions: only the open list gives them.
      if (list === "error") return { ...base, note: "暂时读不到这件事现在的状态，先不能在这里回答", runtime: true };
      if (list === "missing") return { ...base, note: "这件事要在运行面板里处理", runtime: true };
      return { ...base, waiting: "正在读取…" };
    }
    const actions = [];
    if (item.reject) actions.push({ decision: "reject", label: item.reject.label });
    if (item.approve) actions.push({ decision: "approve", label: item.approve.label });
    return {
      ...base, actions, busy: phase === "sending" ? local.decision : "",
      // Agreeing is not possible here: where it is, instead of a dead button.
      note: item.approve ? "" : item.note || "这一项要在运行面板里处理", runtime: !item.approve,
      expiry: expiry(item.expiresAt, now),
      error: phase === "error" ? local.error : null,
    };
  }

  // A refused or failed request in the server's everyday words when it gives
  // them, else the fallback; the engine's own reason apart, for 详情.
  function failure(data, fallback) {
    const said = oneLine(data && data.error);
    const text = han(said) ? said.replace(/[。.]+$/, "") : fallback;
    const n = data && data.native;
    let detail = typeof n === "string" ? oneLine(n)
      : n && typeof n === "object" ? [n.error, n.detail, n.message, n.reason].filter((x) => typeof x === "string" && x.trim()).map(oneLine).join(" · ") : "";
    if (!detail && said && !han(said)) detail = said;
    return { text, detail: detail === text ? "" : detail };
  }

  // ---- 卡片、清单与选项 ----
  // The chat message a pick sends: upstream InteractiveBlock.tsx
  // buildSelectionMessage, ported as it is (the engine's own web client sends
  // exactly these words).
  function buildSelectionMessage(interactiveType, options, selectedIds, messageTemplate, title, customText) {
    if (interactiveType === "confirm") {
      const confirmId = options.find((option) => option.id === "__confirm__")?.id ?? options[0]?.id ?? "__confirm__";
      const action = selectedIds[0] === confirmId ? "确认" : "取消";
      return title ? `${action} — ${title}` : action;
    }

    const selected = selectedIds.map((id) => options.find((o) => o.id === id)).filter(Boolean);
    const labels = selected.map((o) => (o.emoji ? `${o.emoji} ${o.label}` : o.label));

    // If a customInput option was selected and user typed text, use that text
    if (customText) {
      const base = labels.length > 0 ? `${labels.join(", ")}：${customText}` : customText;
      return title ? `${base}（${title}）` : base;
    }

    if (messageTemplate) {
      return messageTemplate.replace("{selection}", labels.join(", "));
    }

    const base = `我选了：${labels.join(", ")}`;
    return title ? `${base}（${title}）` : base;
  }
  // The same for a chat block (kind "choices").
  function choiceMessage(block, selectedIds, customText) {
    const type = block.mode === "confirm" ? "confirm" : block.mode === "multiple" ? "multi-select" : "select";
    return buildSelectionMessage(type, block.options || [], selectedIds, block.template || undefined, block.title || undefined, customText || undefined);
  }
  // A pick the server accepts: one option for a single choice or a
  // confirmation, one to max for a multiple choice; each once, each listed.
  function canPick(block, ids) {
    if (!block || !Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) return false;
    if (!ids.every((id) => (block.options || []).some((o) => o.id === id))) return false;
    if (block.mode !== "multiple") return ids.length === 1;
    return !block.max || ids.length <= block.max;
  }
  // An option as the chat shows it: its emoji before its words.
  const optionText = (o) => (o.emoji ? o.emoji + " " + o.label : o.label);

  // What a choice block shows. local: this page's pick in progress:
  //   {phase: "idle"|"sending"|"recording"|"recorded"|"unsent"|"unrecorded"|"refused"|"conflict",
  //    picks (multiple), ids, text (the message sent), selected (the server's record), error}.
  // It shows answered only from the record: the transcript's (answered,
  // selected) or the answer route's own reply. "conflict" is the server
  // saying it was already answered (409): nothing is offered again on this
  // page; a read of the message that shows its record shows it answered.
  function choice(block, local = null) {
    const phase = local ? local.phase : "idle";
    const recorded = block.answered ? block.selected || [] : phase === "recorded" ? local.selected || [] : null;
    if (recorded) {
      const picked = recorded.map((id) => (block.options || []).find((o) => o.id === id)).filter(Boolean);
      return { mode: "answered", picked: picked.map((o) => ({ id: o.id, text: optionText(o) })) };
    }
    const working = phase === "sending" || phase === "recording";
    const busy = working || phase === "conflict";
    let note = "", tone = "";
    if (phase === "sending") note = "正在发送…";
    else if (phase === "recording") note = "已发出，正在记下这次选择…";
    else if (phase === "unsent") { note = "没发出去，可以再选一次。"; tone = "bad"; }
    else if (phase === "unrecorded") { note = "已经发出「" + oneLine(local.text) + "」，但没能记下这次选择" + (local.error && local.error.text ? "：" + local.error.text : "") + "。可以再选一次。"; tone = "bad"; }
    else if (phase === "refused") { note = (local.error && local.error.text) || "这次选择没有被接受"; tone = "bad"; }
    else if (phase === "conflict") note = ((local.error && local.error.text) || "这个选项已经回答过了") + "，这里不再提供选择。";
    const picks = block.mode === "multiple" && local && Array.isArray(local.picks) ? local.picks : [];
    return {
      mode: "ask", busy, note, tone, picks,
      // The option being sent, for its busy look.
      sending: working && local && Array.isArray(local.ids) ? local.ids : [],
      full: block.mode === "multiple" && !!block.max && picks.length >= block.max,
      ready: block.mode === "multiple" && canPick(block, picks),
      retry: phase === "unrecorded",
    };
  }

  // A diff's lines, each with its kind, and how many were added and removed.
  function diffLines(diff, max = 2000) {
    const all = String(diff || "").replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
    let add = 0, del = 0;
    const lines = all.map((text) => {
      let kind = "ctx";
      if (/^(?:\+\+\+|---)(?: |$)/.test(text) || /^(?:diff |index |new file|deleted file|similarity |rename )/.test(text)) kind = "meta";
      else if (text.startsWith("@@")) kind = "hunk";
      else if (text.startsWith("+")) { kind = "add"; add++; }
      else if (text.startsWith("-")) { kind = "del"; del++; }
      return { kind, text };
    });
    return { lines: lines.slice(0, max), more: Math.max(0, lines.length - max), add, del };
  }
  const hiddenText = (n) => (count(n) ? "还有 " + count(n) + " 项内容暂时无法显示" : "");

  // ---- A reply that did not finish ----
  // The words under a reply that did not finish. When it ended before any
  // words, the server writes these same words as the reply (b1dbf60a,
  // message-presentation.ts), so there is no separate stand-in to know.
  const ENDED = { stopped: "已停止", failed: "这次没完成", interrupted: "中途被打断" };
  function ending(m) {
    const e = m && m.ended;
    if (!e || typeof e !== "object" || !ENDED[e.how]) return null;
    return { how: e.how, label: ENDED[e.how], reason: str(e.reason).trim(), again: e.how !== "stopped" };
  }

  // A message that carries a request for the owner's confirmation: the card
  // is drawn in its place, never the engine's raw words.
  const request = (m) => Array.isArray(m && m.blocks) && m.blocks.some((b) => b && b.kind === "card" && b.approval && typeof b.approval.id === "string" && b.approval.id);
  // The words a reply shows: none for a request's message, and none for an
  // ended reply whose only words are the server's stand-in for "no words".
  function words(m, text) {
    if (request(m)) return "";
    const e = ending(m);
    if (e && oneLine(text) === ENDED[e.how]) return "";
    return text;
  }

  // What a reply was answering, when it can simply be sent again: the owner's
  // message it answered (native replyTo), and the messages the owner said
  // after it had begun and the engine let it take in (listed among its
  // lifecycle.inputMessageIds, and each one's own record saying this reply
  // accepted it), in the order they were said, those on this page only. Each
  // is the owner's own words (not an event); nothing is offered when the
  // owner already sent the first one's words again after the reply. Returns
  // {id, text, files} of the first, with every one of them in `all`.
  function resend(messages, m, group) {
    const id = m && m.native && typeof m.native.replyTo === "string" ? m.native.replyTo : "";
    if (!id || !Array.isArray(messages)) return null;
    const mine = (x) => !!x && (group ? x.kind === "person" : x.role === "user" && !x.internal);
    const idOf = (x) => String((x && (x.native_message_id || x.id)) || "");
    const textOf = (x) => String((group ? x.text : x.content) || "").trim();
    const words = (x) => { const t = textOf(x); return !!t && !t.startsWith("<untrusted_event"); };
    const at = messages.findIndex((x) => mine(x) && idOf(x) === id);
    if (at < 0 || !words(messages[at])) return null;
    const text = textOf(messages[at]);
    const from = Math.max(at, messages.indexOf(m));
    for (let i = from + 1; i < messages.length; i++) if (mine(messages[i]) && textOf(messages[i]) === text) return null;
    const self = m.native && typeof m.native.id === "string" ? m.native.id : idOf(m);
    const inputs = m.native.lifecycle && Array.isArray(m.native.lifecycle.inputMessageIds) ? m.native.lifecycle.inputMessageIds : [];
    const taken = (x) => (x.native && x.native.lifecycle && Array.isArray(x.native.lifecycle.dispatchRefs) ? x.native.lifecycle.dispatchRefs : [])
      .some((r) => !!r && r.appendAcceptance === "accepted" && r.statusMessageId === self);
    const later = messages.map((x, i) => [x, i]).filter(([x, i]) => i !== at && mine(x) && inputs.includes(idOf(x)) && taken(x) && words(x));
    const all = [[messages[at], at], ...later].sort((a, b) => a[1] - b[1])
      .map(([x]) => ({ id: idOf(x), text: textOf(x), files: (x.attachments || []).length }));
    return { id, text, files: (messages[at].attachments || []).length, all };
  }

  window.ClowderCardsRules = Object.freeze({
    KINDS, approvals, outcome, wording, expiry, card, failure,
    buildSelectionMessage, choiceMessage, canPick, optionText, choice,
    diffLines, hiddenText, ending, request, words, resend, count, oneLine,
  });
})();
