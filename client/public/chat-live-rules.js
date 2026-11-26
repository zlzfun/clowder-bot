// Rules for a reply drawn while it is being written (classic script,
// window.ClowderLiveRules). No DOM and no network: chat-live.js draws from
// these and tests load the same file. The contract is docs/chat-live-api.md:
// the thread's event stream carries `live` events (start, thinking, step,
// text with the native cumulative length `end`, done) and transcript rows mark
// a reply still being written with in_progress.
//
// Everything here is a projection of native facts. A reply's words are the
// native draft as the stream and the transcript give it: pieces are placed by
// their native position only, never glued across a gap and never guessed; a
// transcript draft can extend the words but never take back longer words the
// stream already showed. The finished reply always comes from the transcript.
(() => {
  "use strict";
  const str = (v) => (typeof v === "string" ? v : "");
  const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const clip = (s, n) => { const chars = Array.from(s); return chars.length > n ? chars.slice(0, n - 1).join("") + "…" : s; };
  const HELD_MAX = 4000;

  // ---- One reply ----
  // fromStart: this page saw the reply's start marker before any of its words,
  // so a piece without a native position may follow on. broken: some piece was
  // missed or could not be placed, so a piece without a position never can.
  function reply(id, catId, fromStart, now = 0) {
    return {
      id: str(id), catId: str(catId), text: "", fromStart: !!fromStart, broken: false, held: [],
      replacedAt: 0, phase: "start", step: null, done: false, seenAt: now, doneAt: 0,
    };
  }

  // Pieces that arrived ahead of the words so far wait at their native place
  // until what comes before them is known (from the stream or a draft).
  function drain(r) {
    for (;;) {
      r.held = r.held.filter((p) => p.end > r.text.length);
      const next = r.held.find((p) => p.start === r.text.length);
      if (!next) return;
      r.text += next.text;
      r.held.splice(r.held.indexOf(next), 1);
    }
  }
  function hold(r, piece) {
    if (r.held.some((p) => p.start === piece.start && p.end === piece.end)) return;
    r.held.push(piece);
    if (r.held.length > HELD_MAX) r.held.splice(0, r.held.length - HELD_MAX);
  }

  // A `text` event (the contract's alignment rule). true when the words changed.
  function text(r, ev, now) {
    const piece = str(ev.text);
    if (!piece) return false;
    if (ev.replace === true) {
      // The whole reply is this piece now; positions before it no longer hold.
      // (Codex sends the whole reply this way after each paragraph: the same
      // words again change nothing.)
      const changed = r.text !== piece;
      r.text = piece;
      r.held = [];
      r.replacedAt = now;
      return changed;
    }
    const end = ev.end;
    if (Number.isSafeInteger(end) && end >= piece.length) {
      const start = end - piece.length;
      if (start === r.text.length) { r.text += piece; drain(r); return true; }
      // Already here (a newer draft was read first).
      if (end <= r.text.length) return false;
      // A gap before it, or it overlaps words it cannot be checked against:
      // never glued; it waits for the words before it.
      hold(r, { start, end, text: piece });
      r.broken = true;
      return false;
    }
    // No native position: only safe while every piece since the start was seen.
    if (r.fromStart && !r.broken) { r.text += piece; return true; }
    r.broken = true;
    return false;
  }

  // Two steps that read the same: the same tool on the same target, or both on this computer.
  const sameStep = (a, b) => (a.area === "computer" && b.area === "computer") || (a.area === b.area && a.tool === b.tool && a.target === b.target);

  // One live event for this reply. true when what the chat shows may change.
  function apply(r, ev, now = 0) {
    if (!r || !ev || r.done && ev.kind !== "done") return false;
    switch (ev.kind) {
      case "start":
        // Seen from its very start only when nothing of it was known yet.
        if (!r.text && !r.held.length && !r.broken) r.fromStart = true;
        return false;
      case "thinking":
        if (r.phase === "thinking") return false;
        r.phase = "thinking"; r.step = null;
        return true;
      case "step": {
        // area "computer": the step used this computer (the server says so,
        // whichever Agent named the tool). To the owner those steps are one
        // thing, 在用电脑, however many clicks and looks it takes: the next one
        // changes nothing on screen.
        const step = { tool: str(ev.tool), target: str(ev.target), area: ev.area === "computer" ? "computer" : "" };
        if (r.phase === "step" && r.step && sameStep(r.step, step)) return false;
        r.phase = "step"; r.step = step;
        return true;
      }
      case "text": {
        const before = r.phase;
        const changed = text(r, ev, now);
        // Words again (even ones still waiting for their place): whatever it
        // was doing before them is behind it.
        if (str(ev.text)) { r.phase = "text"; r.step = null; }
        return changed || before !== r.phase;
      }
      case "done":
        // Only that the reply stopped being produced: how it ended (finished,
        // stopped, failed) is the transcript's to say.
        if (r.done) return false;
        r.done = true; r.doneAt = now; r.step = null;
        return true;
      default:
        return false;
    }
  }

  // A transcript read's draft of this reply: the native content as the
  // engine last saved it (about every two seconds). How old a saved draft
  // is cannot be told from when it was read, so:
  // - Before any replacement this page saw, the native words only grow: a
  //   draft that continues the words extends them (and fills a gap); one that
  //   differs means a replacement this page missed, and it is the record.
  // - After a replacement this page saw, a draft may be older than it however
  //   late it was read. It is taken only to fill a gap, and only when a piece
  //   received since the replacement (waiting at its place) is in it.
  // Never does a draft take back longer words the stream showed. A draft
  // that adds words the stream has not delivered yet ends following on
  // without a position: the stream's next unpositioned piece may be one of them.
  function vouched(r, d) {
    return r.held.some((p) => p.end <= d.length && d.slice(p.start, p.end) === p.text);
  }
  // Words a draft brought that the stream had not shown were written after
  // whatever step or thinking the stream last reported: the reply is writing
  // words now, and that older description is no longer vouched for.
  function wrote(r) { r.phase = "text"; r.step = null; }
  function draft(r, value) {
    const d = str(value);
    if (!r || d === r.text) return false;
    if (r.replacedAt && !vouched(r, d)) return false;
    if (d.length > r.text.length && d.startsWith(r.text)) {
      r.text = d;
      r.broken = true;
      drain(r);
      wrote(r);
      return true;
    }
    if (r.text.startsWith(d)) return false;
    r.text = d;
    r.held = r.held.filter((p) => p.end > d.length);
    r.broken = true;
    drain(r);
    wrote(r);
    return true;
  }

  // The stream lost events (a reconnect, a sequence gap): nothing can follow
  // on without a native position any more.
  function lost(r) { if (r) r.broken = true; }
  // After such a loss, a read shows the reply still being produced: that much
  // is confirmed; what it was doing then (a step, thinking) is not, so it
  // reads as merely started until the stream says more. true when it changed.
  function recover(r) {
    if (!r || (r.phase !== "step" && r.phase !== "thinking")) return false;
    r.phase = "start";
    r.step = null;
    return true;
  }

  // ---- What the chat shows of the words so far ----
  // As the server does for finished replies: a trailing paw signature on its
  // own line is not shown (outside code fences), nor a last line that opens
  // with "[" and is not closed yet (a signature still being written), nor a
  // reply that is only SILENT or the start of it.
  const SIGNATURE = /(?:^|\r?\n)(?: {0,3}\[[^\[\]\r\n]+🐾\][ \t]*(?:\r?\n|$))+\s*$/u;
  function inFence(text) {
    let fence = "";
    for (const line of text.split(/\r?\n/)) {
      const m = /^[ \t>]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/.exec(line);
      if (!m) continue;
      if (!fence) { if (m[1][0] !== "`" || !m[2].includes("`")) fence = m[1]; }
      else if (m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) fence = "";
    }
    return !!fence;
  }
  // Some models open a reply with the paw signature instead of closing with
  // it ("[团子/Haiku🐾]  今天…"). As the server's withoutLeadingSignature does
  // for finished replies (server/native/message-presentation.ts, the same
  // pattern): only the speaking cat's own name, and only once words follow
  // it on the same line or a later one, so another cat's signature, or one
  // further inside, stays. Until words follow, the rules below already keep
  // a lone or half-written signature line off the screen.
  const LEADING = /^\[([^\[\]\r\n/]{1,80})(?:\/[^\[\]\r\n]{0,80})?\s?🐾\](?:[ \t]+(?=\S)|(?:[ \t]*\r?\n)+(?=[ \t]*\S))/u;
  function leading(value, name) {
    const text = str(value), cat = str(name);
    if (!cat || !text.startsWith("[")) return text;
    const m = LEADING.exec(text);
    return m && m[1].trim() === cat ? text.slice(m[0].length) : text;
  }
  // A reply that went on after the cat had signed (the owner said more while
  // it was writing and the engine let the same reply continue) carries that
  // signature in the middle. As the server's withoutOwnSignatureLines does
  // for finished replies (server/native/message-presentation.ts, the same
  // patterns): such a signature is a paragraph of its own, a line at the left
  // margin that is nothing but the speaking cat's own paw signature with a
  // blank line (or the start, or the end) on either side, outside code
  // fences. Only that is hidden, with one of the blank lines around it.
  // Another cat's signature, one inside a sentence, quoted, indented, in a
  // list item or table cell, or directly above or below other text stays.
  // While the reply is written, whether a blank line follows is not known
  // yet: a signature that is still the last paragraph is held back by the
  // trailing rules of display(), and this keeps it hidden once a blank line
  // and more words follow it.
  const OWN_LINE = /^\[([^\[\]\r\n/]{1,80})(?:\/[^\[\]\r\n]{0,80})?\s?🐾\][ \t]*$/u;
  // A fence opens or closes with at most three spaces before it; inside one,
  // only a bare marker of the same kind and at least the same length closes it.
  const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  function middle(value, name) {
    const text = str(value), cat = str(name);
    if (!cat || !text.includes("🐾]")) return text;
    const lines = text.split(/\r?\n/), kept = [];
    let fence = "", opening = false;
    lines.forEach((line, index) => {
      // The reply began with the signature: the blank line after it goes with it.
      if (opening) { opening = false; if (line.trim() === "") return; }
      const mark = FENCE.exec(line);
      if (mark) {
        if (!fence) { if (mark[1][0] !== "`" || !mark[2].includes("`")) fence = mark[1]; }
        else if (mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim()) fence = "";
      }
      const own = !fence && !mark ? OWN_LINE.exec(line) : null;
      const alone = (index === 0 || lines[index - 1].trim() === "") && (index === lines.length - 1 || lines[index + 1].trim() === "");
      if (own && alone && own[1].trim() === cat) {
        // It stood between two blank lines: one of them is enough.
        if (!kept.length) opening = true;
        else if (kept[kept.length - 1].trim() === "" && index < lines.length - 1) kept.pop();
        return;
      }
      kept.push(line);
    });
    return kept.join("\n").replace(/\s+$/, "");
  }
  // name: the speaking cat's name ("" when not known: nothing leading, and no
  // signature in the middle, is cut).
  function display(value, name) {
    let text = leading(str(value), name).replace(/\r\n/g, "\n");
    const bare = text.trim();
    if (!bare || "SILENT".startsWith(bare)) return "";
    for (let i = 0; i < 4; i++) {
      const before = text;
      // A last line that opens a bracket it has not closed: it may be a
      // signature (inside a code block it is code, and shows as it comes).
      const cut = text.lastIndexOf("\n") + 1;
      const last = text.slice(cut);
      if (/^\s{0,3}\[/.test(last) && !last.includes("]") && !inFence(text.slice(0, cut))) text = text.slice(0, cut);
      const sig = SIGNATURE.exec(text);
      if (sig && !inFence(text.slice(0, sig.index))) text = text.slice(0, sig.index);
      text = text.replace(/\s+$/, "");
      if (text === before) break;
    }
    text = middle(text, name);
    return "SILENT".startsWith(text.trim()) ? "" : text;
  }
  // Words to draw: a code fence still being written is drawn closed (the
  // renderer pairs ``` marks), so code reads as code from its first line
  // instead of turning into a block only when the fence closes.
  function drawable(text) {
    const s = str(text);
    return (s.match(/```/g) || []).length % 2 ? s + "\n```" : s;
  }

  // ---- The quiet line under a reply in progress ----
  // A native tool name in everyday words; the target is only ever a file name,
  // a site or a short query the server already reduced it to, and is shown
  // only where it reads naturally. Never a tool name, a command or a path.
  const VERBS = [
    [/^(read|readfile|view|viewfile|cat|open|openfile|notebookread|readnotebook|readmanyfiles)$/, "look"],
    [/^(write|writefile|create|createfile|newfile|filechange)$/, "write"],
    [/^(edit|editfile|multiedit|notebookedit|replace|strreplace|strreplaceeditor|applypatch|patch|editnotebook|insert)$/, "edit"],
    [/^(bash|shell|sh|exec|execcommand|commandexecution|runshellcommand|runcommand|command|terminal|localshell|run|powershell|cmd|killshell|bashoutput)$/, "run"],
    [/^(grep|glob|find|findfiles|search|searchfiles|searchfilecontent|listdirectory|listdir|ls|list|codesearch|ripgrep|rg)$/, "dig"],
    [/^(websearch|googlewebsearch|googlesearch|websearchtool|searchweb|bingsearch|internetsearch)$/, "web"],
    [/^(webfetch|fetch|fetchurl|browse|openurl|readurl|urlfetch|httpget|webopen)$/, "site"],
    [/^(task|agent|subagent|spawn|spawnagent|delegate|dispatch|parallel)$/, "split"],
    [/^(todowrite|todo|todoread|updateplan|plan|updatetodos|writetodos)$/, "plan"],
  ];
  function verb(tool) {
    const raw = str(tool);
    if (/^mcp(__|_tool_call$)/i.test(raw)) {
      const name = raw.toLowerCase();
      if (/search|query|lookup|find/.test(name)) return "lookup";
      if (/memory|recall|remember/.test(name)) return "memory";
      if (/browser|chrome|playwright|navigate|page|tab/.test(name)) return "browser";
      return "tool";
    }
    const name = raw.toLowerCase().replace(/[^a-z]/g, "");
    for (const [re, kind] of VERBS) if (re.test(name)) return kind;
    return "";
  }
  // A target fit for one quiet line: one line, short, and never a path.
  function target(value) {
    const t = oneLine(value);
    if (!t || /[\\/]/.test(t)) return "";
    return clip(t, 24);
  }
  // area "computer" (the step event's own field): 在用电脑, with no tool name
  // and no target (the tool names are never parsed for it).
  function stepWords(tool, rawTarget, area) {
    if (area === "computer") return "在用电脑";
    const kind = verb(tool), t = target(rawTarget);
    switch (kind) {
      case "look": return t ? "在看 " + t : "在看文件";
      // Codex's file_change both creates and edits: with a file named it is
      // writing that file, without one it is changing files.
      case "write": return t ? "在写 " + t : verb(tool) === "write" && /change/i.test(str(tool)) ? "在改文件" : "在写文件";
      case "edit": return t ? "在改 " + t : "在改文件";
      case "run": return "在运行命令";
      case "dig": return "在翻找文件";
      case "web": return t ? "在搜索「" + t + "」" : "在搜索";
      case "site": return t ? "在读 " + t : "在读网页";
      case "split": return "在分头处理";
      case "plan": return "在列计划";
      case "lookup": return "在查找";
      case "memory": return "在回想";
      case "browser": return "在用浏览器";
      case "tool": return "在用工具";
      default: return "在处理";
    }
  }
  // The quiet line for a reply's current state ("" when there is none).
  function phrase(r) {
    if (!r || r.done) return "";
    if (r.phase === "step" && r.step) return stepWords(r.step.tool, r.step.target, r.step.area);
    if (r.phase === "thinking") return "在想…";
    return "";
  }

  // ---- Which native events change the record (and so need a read) ----
  // The pieces of a turn the live stream already draws, and engine telemetry,
  // change nothing a read would show until the turn ends. Anything else
  // (done, error, queue, thread, task, approval, connector and message
  // updates, a resync or a disconnect, and any type not known here) does.
  // A text event that is not part of the reply stream (an explicit post) is
  // a new message: it is read.
  const CHUNKS = new Set(["text", "tool_use", "tool_result", "system_info", "session_init", "status",
    "provider_signal", "liveness_signal", "agent_loop", "thinking", "heartbeat"]);
  function structural(ev) {
    const type = ev && typeof ev.type === "string" ? ev.type : "";
    if (type === "text") return ev.origin !== "stream";
    return !CHUNKS.has(type);
  }
  // Events after which the stream may have missed something.
  const gap = (ev) => !!ev && (ev.type === "resync" || ev.type === "disconnected");

  // ---- The send's answer ----
  // POST <scope>/messages answers as an event stream (a cat) or JSON (a group).
  // The receipt is the native admission; it never means the reply is done.
  function receipt(body, json) {
    if (json) {
      const data = body && typeof body === "object" ? body : {};
      return { receipt: data, userMessageId: str(data.userMessageId), error: "" };
    }
    let found = null, error = "";
    for (const block of str(body).replace(/\r\n/g, "\n").split("\n\n")) {
      let event = "message", data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      let payload = null;
      try { payload = JSON.parse(data); } catch (e) { continue; }
      if (event === "error") error = str(payload && (payload.error || payload.message)) || "回复出错了";
      else if (event === "queued" && payload && typeof payload === "object") found = payload;
    }
    return { receipt: found || {}, userMessageId: str(found && found.userMessageId), error };
  }

  // ---- Where a reply is drawn ----
  // A reply that took in what the owner said after it had begun (the engine
  // let the running reply continue with it) carries `follows`: the last such
  // message of the owner's, by its seq in a single chat and by its id in a
  // group (docs/chat-live-api.md 「会话行」). The rows keep the engine's
  // order, where the reply comes first because it began first; the chat draws
  // such a reply right after the message `follows` names, so it reads as two
  // questions and one answer, while it is being written and once it is done.
  // Only `follows` decides it, never times or words, and only when the row it
  // names is in what is loaded, is the owner's, and comes after the reply;
  // otherwise the reply stays where it is. Replies drawn after the same
  // message keep their order. Returns the rows' indices in drawing order.
  function order(messages, group) {
    const list = Array.isArray(messages) ? messages : [];
    const mine = (m) => !!m && (group ? m.kind === "person" : m.role === "user");
    const keyOf = (m) => (group ? (typeof m.id === "string" && m.id ? "i:" + m.id : "") : (Number.isSafeInteger(Number(m.seq)) && Number(m.seq) > 0 ? "s:" + Number(m.seq) : ""));
    const named = (m) => {
      const f = m.follows;
      if (group) return typeof f === "string" && f ? "i:" + f : "";
      return (typeof f === "number" || typeof f === "string") && Number.isSafeInteger(Number(f)) && Number(f) > 0 ? "s:" + Number(f) : "";
    };
    const at = new Map();
    list.forEach((m, i) => { if (mine(m)) { const k = keyOf(m); if (k && !at.has(k)) at.set(k, i); } });
    // The owner's reaction is drawn on the row it reacts to (reactions[],
    // chat-reactions.js): a follow-up that names it names that row.
    list.forEach((m, i) => {
      for (const r of m && Array.isArray(m.reactions) ? m.reactions : []) {
        if (!r || r.mine !== true) continue;
        const k = group ? (typeof r.id === "string" && r.id ? "i:" + r.id : "") : (Number.isSafeInteger(Number(r.seq)) && Number(r.seq) > 0 ? "s:" + Number(r.seq) : "");
        if (k && !at.has(k)) at.set(k, i);
      }
    });
    const under = new Map(), moved = new Set();
    list.forEach((m, i) => {
      if (!m || mine(m) || m.follows == null) return;
      const k = named(m), t = k ? at.get(k) : undefined;
      if (t === undefined || t <= i) return;
      moved.add(i);
      if (!under.has(t)) under.set(t, []);
      under.get(t).push(i);
    });
    const out = [];
    list.forEach((_, i) => {
      if (moved.has(i)) return;
      out.push(i);
      for (const j of under.get(i) || []) out.push(j);
    });
    return out;
  }
  // The rows that come before the row with this message ID in the engine's
  // order but are drawn below it (a reply moved under a later message), the
  // owner's own messages aside: their IDs. Reading up to that message (the
  // read position is cumulative) covers them too, so they have to have been
  // seen as well. drawn: {messages, order, group} as the history was drawn.
  function displaced(drawn, id) {
    const list = drawn && Array.isArray(drawn.messages) ? drawn.messages : [], ord = drawn && Array.isArray(drawn.order) ? drawn.order : [];
    const idOf = (m) => String((m && (drawn.group ? m.id : m.native_message_id || m.id)) || "");
    const mine = (m) => !!m && (drawn.group ? m.kind === "person" : m.role === "user");
    const at = list.findIndex((m) => idOf(m) === String(id || ""));
    if (at < 0 || !id) return [];
    const pos = new Map(ord.map((i, p) => [i, p]));
    if (!pos.has(at)) return [];
    return ord.filter((i) => i < at && pos.get(i) > pos.get(at) && !mine(list[i]) && idOf(list[i])).map((i) => idOf(list[i]));
  }

  // ---- Redraw identity ----
  // A row's drawn markup with the per-drawing SVG ids (clip paths of the cat
  // faces, glyph tiles) made neutral, so the same row drawn twice compares equal.
  const signature = (html) => str(html).replace(/\b(xbot-glyph|clowder-cat-crop)-\d+\b/g, "$1-#");

  window.ClowderLiveRules = Object.freeze({
    reply, apply, draft, lost, recover, display, leading, middle, drawable, stepWords, phrase, structural, gap, receipt, signature,
    // The order a conversation's rows are drawn in (a reply under the follow-ups it took in),
    // and the rows drawn below a message although they came before it.
    order, displaced,
    // A native tool name's everyday kind ("look", "run", … or ""), for the
    // header's shorter words (chat-presence-rules.js).
    verb,
  });
})();
