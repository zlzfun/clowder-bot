// Rules for what a cat attaches to a reply, asks the owner to confirm, or
// leaves unfinished (classic script, window.ClowderCardsRules). No DOM and no
// network: chat-cards.js draws from these and tests load the same file.
//
// Everything here reads what the server projected (docs/chat-experience-api.md
// 「卡片、清单与选项」「等你确认的事」, docs/chat-live-api.md). A request card
// says only what the server has confirmed: an answer the owner gave is 已提交
// until the engine's receipt (on any page held), the list's settled read or
// the answer's own verified reply names the outcome, and a request that is no
// longer listed as open, with nothing that says how, is only 已处理.
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
  const STATES = ["approved", "rejected", "closed"];
  const OUTCOMES = ["accept", "decline", "cancel"];
  const filled = (v) => (typeof v === "string" && v.trim() ? v : "");
  const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  // Public labels the server says were chosen (never a typed or secret answer: the server leaves those out).
  const labels = (v) => (Array.isArray(v) ? [...new Set(v.map(oneLine).filter(Boolean))].slice(0, 20) : []);

  // An F306 question, approval, elicitation or conversation decision as the
  // chat can answer it (docs/chat-experience-api.md 「等你确认的事」, runtime).
  // Labels stay exactly as the server gave them: an answer is the label itself.
  // null when any part is not what the contract says; such a request is then
  // answered in the runtime panel, never half drawn.
  function decisionsOf(list) {
    if (!Array.isArray(list) || !list.length) return null;
    const out = [], ids = new Set();
    for (const d of list) {
      if (!d || typeof d !== "object" || typeof d.id !== "string" || !d.id || ids.has(d.id) || !filled(d.label) || !OUTCOMES.includes(d.outcome)) return null;
      ids.add(d.id);
      out.push({ id: d.id, label: d.label.trim(), description: oneLine(d.description), outcome: d.outcome });
    }
    return out;
  }
  const FIELD_TYPES = ["string", "number", "integer", "boolean"];
  const primitive = (v) => typeof v === "string" || typeof v === "boolean" || finite(v) !== null;
  function runtimePrompt(raw) {
    if (!raw || typeof raw !== "object") return null;
    const revision = Number.isSafeInteger(raw.revision) && raw.revision > 0 ? raw.revision : 0;
    if (!revision) return null;
    if (raw.kind === "question") {
      if (!Array.isArray(raw.questions) || !raw.questions.length) return null;
      const questions = [], ids = new Set();
      for (const q of raw.questions) {
        if (!q || typeof q !== "object" || typeof q.id !== "string" || !q.id || ids.has(q.id)) return null;
        const question = filled(q.question).trim(), header = oneLine(q.header);
        if (!question && !header) return null;
        ids.add(q.id);
        let options = null;
        if (q.options != null) {
          if (!Array.isArray(q.options) || !q.options.length) return null;
          options = [];
          for (const o of q.options) {
            if (!o || typeof o !== "object" || !filled(o.label)) return null;
            if (!options.some((x) => x.label === o.label)) options.push({ label: o.label, description: oneLine(o.description) });
          }
        }
        questions.push({ id: q.id, header, question: question || header, options,
          multiSelect: q.multiSelect === true, isOther: q.isOther === true, isSecret: q.isSecret === true, allowUnanswered: q.allowUnanswered === true });
      }
      return { kind: "question", revision, questions };
    }
    if (raw.kind === "approval") {
      const decisions = decisionsOf(raw.decisions);
      return decisions ? { kind: "approval", revision, decisions } : null;
    }
    if (raw.kind === "elicitation") {
      const decisions = decisionsOf(raw.decisions), message = str(raw.message).trim();
      if (!decisions) return null;
      if (raw.mode === "url") {
        // Only a web address opens from the chat: never javascript:, data: or file:.
        const url = str(raw.url).trim();
        return /^https?:\/\/[^\s/?#]+/i.test(url) && !/\s/.test(url) ? { kind: "elicitation", revision, mode: "url", message, url, decisions } : null;
      }
      if (raw.mode !== "form" || !Array.isArray(raw.fields)) return null;
      const fields = [], ids = new Set();
      for (const f of raw.fields) {
        if (!f || typeof f !== "object" || typeof f.id !== "string" || !f.id.trim() || ids.has(f.id) || !FIELD_TYPES.includes(f.type)) return null;
        if (f.enum != null && (!Array.isArray(f.enum) || !f.enum.length || !f.enum.every(primitive))) return null;
        ids.add(f.id);
        fields.push({
          id: f.id, type: f.type, title: oneLine(f.title), description: oneLine(f.description),
          default: primitive(f.default) ? f.default : null, enum: f.enum ? f.enum.slice() : null,
          minimum: finite(f.minimum), maximum: finite(f.maximum),
          minLength: Number.isSafeInteger(f.minLength) && f.minLength >= 0 ? f.minLength : null,
          maxLength: Number.isSafeInteger(f.maxLength) && f.maxLength > 0 ? f.maxLength : null,
          required: f.required === true,
        });
      }
      return { kind: "elicitation", revision, mode: "form", message, fields, decisions };
    }
    if (raw.kind === "conversation") {
      if (!["single", "multiple", "confirm"].includes(raw.mode) || !Array.isArray(raw.options) || !raw.options.length) return null;
      const options = [], ids = new Set();
      for (const o of raw.options) {
        if (!o || typeof o !== "object" || typeof o.id !== "string" || !o.id || ids.has(o.id) || !filled(o.label)) return null;
        ids.add(o.id);
        options.push({ id: o.id, label: o.label.trim(), emoji: oneLine(o.emoji), description: oneLine(o.description), custom: o.custom === true });
      }
      // A confirmation is its "yes", and its "no" when it has one.
      if (raw.mode === "confirm" && options.length > 2) return null;
      return { kind: "conversation", revision, mode: raw.mode, options,
        max: raw.mode === "multiple" && Number.isSafeInteger(raw.max) && raw.max > 0 ? raw.max : 0, allowText: raw.allowText === true };
    }
    return null;
  }

  // GET <scope>/approvals, checked: the open requests of one conversation,
  // and (asked for with ?ids=) how requests that are no longer open ended.
  // null when the answer is not such a list at all.
  function approvals(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.approvals)) return null;
    const action = (a) => (a && typeof a === "object" && oneLine(a.label) ? { label: oneLine(a.label) } : null);
    const list = [];
    for (const raw of data.approvals) {
      if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id || typeof raw.messageId !== "string") continue;
      if (raw.state != null && raw.state !== "open") continue;
      const item = {
        id: raw.id, kind: KINDS.includes(raw.kind) ? raw.kind : "other",
        title: oneLine(raw.title), body: str(raw.body).replace(/\r\n?/g, "\n").trim(), quote: oneLine(raw.quote),
        catId: str(raw.catId), catName: oneLine(raw.catName), messageId: raw.messageId,
        createdAt: time(raw.createdAt), expiresAt: time(raw.expiresAt),
        approve: action(raw.approve), reject: action(raw.reject), note: oneLine(raw.note),
      };
      if (raw.runtime != null) {
        // Answered here only as the server described it; a description this page cannot read goes to the runtime panel.
        const prompt = runtimePrompt(raw.runtime);
        if (prompt && item.approve) item.runtime = prompt;
        else Object.assign(item, { approve: null, reject: null, note: item.note || "这一项要在运行面板里回答" });
      }
      list.push(item);
    }
    const settled = [];
    for (const s of Array.isArray(data.settled) ? data.settled : []) {
      if (!s || typeof s !== "object" || typeof s.id !== "string" || !s.id || !STATES.includes(s.state)) continue;
      settled.push({ id: s.id, state: s.state, selected: labels(s.selected) });
    }
    return { threadId: str(data.threadId), list, settled };
  }

  // The engine's receipt on a row: {id, state, card?} (the row's receipt, or
  // the native message it carries), else null. Any page held may have it.
  // card: the message of the request card it answers, when the receipt names
  // one (a receipt for another message never settles this card).
  function receiptOf(m) {
    if (!m || typeof m !== "object") return null;
    const r = m.receipt;
    if (r && typeof r === "object" && typeof r.proposalId === "string" && r.proposalId && STATES.includes(r.state)) {
      return { id: r.proposalId, state: r.state, ...(typeof r.cardMessageId === "string" && r.cardMessageId ? { card: r.cardMessageId } : {}) };
    }
    const src = m.native && typeof m.native === "object" ? m.native.source : null;
    const d = src && src.meta && typeof src.meta === "object" ? src.meta.approvalDecisionReceipt : null;
    if (!src || src.connector !== "approval-hub" || !d || d.kind !== "approval_decision_receipt" || typeof d.canonicalProposalId !== "string" || !d.canonicalProposalId) return null;
    const card = d.approvalCardRef && typeof d.approvalCardRef.messageId === "string" ? d.approvalCardRef.messageId : "";
    return { id: d.canonicalProposalId, state: d.resolution === "accepted" ? "approved" : d.resolution === "rejected" ? "rejected" : "closed", ...(card ? { card } : {}) };
  }

  // How an answered request turned out, from the engine's receipt (state),
  // said for what it was. A schedule request sets a timer, changes one or
  // removes one; its title says which, by its verb (never by the cat's name
  // in front of it).
  const OUTCOME = {
    preference: ["已记住这个偏好", "没有记这个偏好"],
    profile: ["已更新关于你的资料", "没有更新关于你的资料"],
    person: ["已记下这个人", "没有记这个人"],
    schedule: ["已设好这个定时", "没有设这个定时"],
    reschedule: ["已改好这个定时", "没有改这个定时"],
    unschedule: ["已取消这个定时", "这个定时还留着"],
    question: ["已回答", "已拒绝"],
    other: ["已同意", "已拒绝"],
  };
  const timer = (title) => (/想取消一个定时/.test(title) ? "unschedule" : /想改一个定时/.test(title) ? "reschedule" : "schedule");
  function outcome(kind, state, title = "") {
    if (state === "closed") return "已结束";
    const words = OUTCOME[kind === "schedule" ? timer(title) : kind] || OUTCOME.other;
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

  // The actions of a request the chat answers itself (an F306 prompt): one
  // per native decision (the first that accepts is the primary, last),
  // 提交回答 for questions and choices (with 拒绝 for a question), or the
  // answers of a confirmation (its "no" when it has one, then its "yes").
  function runtimeActions(p, item) {
    if (p.kind === "question") {
      return [...(item.reject ? [{ decision: "reject", label: item.reject.label }] : []), { decision: "submit", label: item.approve.label, primary: true }];
    }
    if (p.kind === "conversation") {
      if (p.mode !== "confirm") return [{ decision: "submit", label: item.approve.label, primary: true }];
      const [yes, no] = p.options;
      return [...(no ? [{ decision: "opt:" + no.id, label: optionText(no) }] : []), { decision: "opt:" + yes.id, label: optionText(yes), primary: true }];
    }
    const first = p.decisions.find((d) => d.outcome === "accept");
    const act = (d, primary) => ({ decision: "pick:" + d.id, label: d.label, ...(d.description ? { description: d.description } : {}), ...(primary ? { primary: true } : {}) });
    return [...p.decisions.filter((d) => d !== first).map((d) => act(d, false)), ...(first ? [act(first, true)] : [])];
  }

  // What a request card shows.
  //   fact:  the transcript's card block ({approval: {id, kind, title, body?, state?, selected?}});
  //   item:  the open request with that ID, or null when it is not listed;
  //   list:  how this conversation's open list stands: "idle" (not read yet),
  //          "loading", "ready", "error" or "missing" (no such route);
  //   seen:  the request as this page last listed it;
  //   local: the owner's answer from this page: {phase: "sending"|"sent"|"error",
  //          decision, settled (true|false|null), error: {text, detail}};
  //   fresh: the list was asked for after that answer;
  //   resolved: how it ended by evidence other than this row ({state, selected?}):
  //          the engine's receipt on another page held here, the list's
  //          settled read (?ids=), or the answer's own verified reply;
  //   reloaded: after that answer, both a list read and a read of the
  //          conversation came back (the receipt had its chance to arrive);
  //   catName: who asked (the message's cat), now: the time.
  // mode "ask" is the card (its actions only ever from the open list; busy:
  // the answer being sent; waiting / note: why there are none; prompt: what
  // an F306 request asks, answered in the card); mode "line" is one settled
  // or neutral line.
  function card({ fact, item = null, list = "idle", seen = null, local = null, fresh = false, catName = "", now = 0, resolved = null, reloaded = false }) {
    const approval = fact && fact.approval ? fact.approval : {};
    const known = STATES.includes(approval.state) ? approval.state : "";
    const later = !known && resolved && STATES.includes(resolved.state) ? resolved : null;
    const state = known || (later ? later.state : "");
    const w = wording(approval, item, seen, catName);
    const line = (tone, text, icon, more = {}) => ({ mode: "line", kind: w.kind, tone, icon, text, what: w.body, runtime: false, ...more });
    if (state) {
      // The public choices it ended with, after the outcome, unless the outcome already says them (已拒绝 · 拒绝).
      const said = outcome(w.kind, state, w.title);
      const picked = labels(later ? later.selected : approval.selected).filter((s) => !said.includes(s));
      return line(state === "approved" ? "ok" : state === "rejected" ? "no" : "exp", said + (picked.length ? "：" + picked.join("、") : ""), state === "approved" ? "check" : state === "rejected" ? "x" : "clock");
    }
    const phase = local ? local.phase : "";
    if (phase === "sent") {
      // What the answer's own reply said, until a read made after it says more.
      if (fresh && list === "ready") {
        if (item) return line("neutral", "已提交，还在处理", "hourglass");
        // Read again since, and nothing anywhere says how: no longer waiting, never stuck on 已提交.
        if (reloaded === true) return line("neutral", "已处理", "circle-check");
        return local.settled === true ? line("neutral", "已提交", "check") : line("neutral", "已处理", "circle-check");
      }
      if (local.settled === true) return line("neutral", "已提交", "check");
      if (local.settled === false) return line("neutral", "已提交，还在处理", "hourglass");
      return line("neutral", "没能确认结果，稍后会更新", "info");
    }
    // No longer open, and nothing on this page says how: neutral.
    if (list === "ready" && !item && phase !== "sending") return line("neutral", "已处理", "circle-check");
    const base = { mode: "ask", kind: w.kind, title: w.title, body: w.body, quote: w.quote, actions: [], busy: "", waiting: "", note: "", runtime: false, expiry: "", error: null, prompt: null };
    if (!item) {
      // Drawn from the row alone, without actions: only the open list gives them.
      if (list === "error") return { ...base, note: "暂时读不到这件事现在的状态，先不能在这里回答", runtime: true };
      if (list === "missing") return { ...base, note: "这件事要在运行面板里处理", runtime: true };
      return { ...base, waiting: "正在读取…" };
    }
    const prompt = item.runtime && item.approve ? item.runtime : null;
    const actions = [];
    if (prompt) actions.push(...runtimeActions(prompt, item));
    else {
      if (item.reject) actions.push({ decision: "reject", label: item.reject.label });
      if (item.approve) actions.push({ decision: "approve", label: item.approve.label });
    }
    return {
      ...base, actions, prompt, busy: phase === "sending" ? local.decision : "",
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

  // ---- Answering an F306 request in its card ----
  // The answer sent is built from what the card shows (the draft: picks,
  // typed words, skipped questions, form values), checked here first in the
  // server's own words; the server and the engine check it again.
  //   draft: {answers: {[questionId]: {picks: [label], text, skip}},
  //           fields: {[fieldId]: value as the control holds it},
  //           picks: [optionId], custom, text} (a conversation decision).
  // Each returns {response} or {invalid, at?} (at: the question or field).
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  // A question's answer: its picked options in their order, the owner's own
  // words for a question without options or with 其他 (in place of the pick of
  // a single choice, after the picks of a multiple one); none when skipped.
  function answerOf(q, s) {
    s = s && typeof s === "object" ? s : {};
    if (q.allowUnanswered && s.skip) return [];
    const own = !q.options || q.isOther ? str(s.text).trim() : "";
    if (!q.options) return own ? [own] : [];
    const picks = Array.isArray(s.picks) ? q.options.map((o) => o.label).filter((l) => s.picks.includes(l)) : [];
    if (!q.multiSelect) return own ? [own] : picks.slice(0, 1);
    return own && !picks.includes(own) ? [...picks, own] : picks;
  }
  function questionResponse(p, draft) {
    const answers = {}, many = p.questions.length > 1;
    for (const q of p.questions) {
      const s = draft && draft.answers ? draft.answers[q.id] : null;
      const values = answerOf(q, s);
      if (!values.length && !(q.allowUnanswered && s && s.skip)) {
        const need = q.options ? (q.isOther ? "选一项或写下回答" : q.multiSelect ? "至少选一项" : "选一项") : "写下回答";
        return { invalid: many ? "请回答：" + oneLine(q.header || q.question).slice(0, 60) : "请先" + need, at: q.id };
      }
      answers[q.id] = values;
    }
    return { response: { kind: "answers", answers } };
  }
  // A form field's value before the owner touched it, as its control holds
  // it: the field's default (an enum by its position), else empty / unchecked.
  function fieldDefault(f) {
    if (f.enum) { const i = f.default == null ? -1 : f.enum.indexOf(f.default); return i >= 0 ? String(i) : ""; }
    if (f.type === "boolean") return f.default === true;
    return f.default == null ? "" : String(f.default);
  }
  function formResponse(p, values) {
    const content = {};
    for (const f of p.fields) {
      const name = f.title || f.id, bad = (invalid) => ({ invalid, at: f.id });
      const raw = has(values, f.id) ? values[f.id] : fieldDefault(f);
      // A checkbox always says something: what it shows is what is sent.
      if (f.type === "boolean" && !f.enum) { content[f.id] = raw === true; continue; }
      if (f.enum) {
        const i = raw === "" || raw == null ? -1 : Number(raw);
        if (Number.isInteger(i) && i >= 0 && i < f.enum.length) content[f.id] = f.enum[i];
        else if (f.required) return bad("请填写：" + name);
        continue;
      }
      const said = String(raw == null ? "" : raw).trim();
      if (!said) { if (f.required) return bad("请填写：" + name); continue; }
      if (f.type === "number" || f.type === "integer") {
        const n = Number(said);
        if (!Number.isFinite(n) || (f.type === "integer" && !Number.isInteger(n))) return bad(name + "需要填写" + (f.type === "integer" ? "整数" : "数字"));
        if (f.minimum != null && n < f.minimum) return bad(name + "不能小于 " + f.minimum);
        if (f.maximum != null && n > f.maximum) return bad(name + "不能大于 " + f.maximum);
        content[f.id] = n;
      } else {
        if (f.minLength != null && said.length < f.minLength) return bad(name + "至少需要 " + f.minLength + " 个字");
        if (f.maxLength != null && said.length > f.maxLength) return bad(name + "最多 " + f.maxLength + " 个字");
        content[f.id] = said;
      }
    }
    return { content };
  }
  // A conversation decision: the options picked (with the picked 自定义
  // option's words), or, where the cat allows it, the owner's own reply instead.
  function conversationResponse(p, draft) {
    const d = draft && typeof draft === "object" ? draft : {};
    const own = p.allowText ? str(d.text).trim() : "";
    const ids = (Array.isArray(d.picks) ? d.picks : []).filter((id, i, a) => a.indexOf(id) === i && p.options.some((o) => o.id === id));
    if (!ids.length) {
      if (own) return { response: { kind: "text", text: own } };
      return { invalid: p.allowText ? "请选一项，或写下你的回答" : p.mode === "multiple" ? "请至少选一项" : "请选一项" };
    }
    if (p.mode !== "multiple" && ids.length !== 1) return { invalid: "这里只能选一项" };
    if (p.max && ids.length > p.max) return { invalid: "最多选 " + p.max + " 项" };
    const custom = p.options.find((o) => o.custom && ids.includes(o.id));
    const words = custom ? str(d.custom).trim() : "";
    if (custom && !words) return { invalid: "请填写：" + custom.label, at: custom.id };
    return { response: { kind: "selection", selectedIds: ids, ...(words ? { customInput: words } : {}) } };
  }
  // The answer for one of the card's actions (runtimeActions): submit, a
  // native decision (an accepted form sends its content, any other none), or
  // one answer of a confirmation.
  function runtimeResponse(p, decision, draft) {
    const d = draft && typeof draft === "object" ? draft : {};
    if (p.kind === "question" && decision === "submit") return questionResponse(p, d);
    if (p.kind === "conversation") {
      if (p.mode !== "confirm") return decision === "submit" ? conversationResponse(p, d) : { invalid: "请选一项" };
      const id = String(decision).replace(/^opt:/, "");
      return p.options.some((o) => o.id === id) ? { response: { kind: "selection", selectedIds: [id] } } : { invalid: "请选一项" };
    }
    if (p.kind === "approval" || p.kind === "elicitation") {
      const choice = p.decisions.find((x) => "pick:" + x.id === decision);
      if (!choice) return { invalid: "请选择一项处理方式" };
      if (p.kind === "elicitation" && p.mode === "form" && choice.outcome === "accept") {
        const got = formResponse(p, d.fields);
        return got.content ? { response: { kind: "decision", decisionId: choice.id, content: got.content } } : got;
      }
      return { response: { kind: "decision", decisionId: choice.id } };
    }
    return { invalid: "这一项要在运行面板里回答" };
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
    KINDS, STATES, approvals, runtimePrompt, receiptOf, labels, outcome, wording, expiry, card, failure,
    runtimeActions, answerOf, questionResponse, fieldDefault, formResponse, conversationResponse, runtimeResponse,
    buildSelectionMessage, choiceMessage, canPick, optionText, choice,
    diffLines, hiddenText, ending, request, words, resend, count, oneLine,
  });
})();
