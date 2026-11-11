// Search and jump: the rules of the ⌘K palette, without a DOM (classic
// script, window.ClowderPaletteRules). Loads before palette.js; the tests run
// it in a bare VM.
//
// - Names: 猫猫 and 群聊 are filtered by name on the page, at once, best match
//   first (the whole name, then its start, then a later word, then anywhere);
//   a group also answers to its members' names, after every name match. Ties
//   keep the sidebar's order.
// - What was said: GET /xbot-api/search?q= (docs/xbot-api.md「搜索」) takes 1–100
//   characters after trimming; its results are newest first, with the match's
//   place in the snippet. A scope keeps only one chat's results (its current
//   conversation). How much was searched is said plainly: conversations that
//   could not be read (`failed`) and anything not looked at or not listed
//   (`more`) are never shown as "nothing found".
// - Keys: ⌘K (macOS) or Ctrl+K opens the palette; Alt+↑ / Alt+↓ go to the
//   previous / next chat in the sidebar's order, stopping at either end.
(() => {
  "use strict";
  // GET /search accepts 1–100 characters (after trimming) and lists 30 at most.
  const MAX_QUERY = 100;
  const LIMIT = 30;
  // How long typing rests before what was said is searched.
  const DEBOUNCE = 220;
  // Chats shown for an empty query, and at most for a name match.
  const RECENT = 6;
  const CHATS = 8;

  const text = (v) => (v == null ? "" : String(v));
  const fold = (v) => text(v).replace(/\s+/g, " ").trim().toLowerCase();
  // A word starts after a space or a mark (latin and CJK punctuation).
  const BOUNDARY = /[\s\-_·•.,;:!?/\\|()[\]{}<>"'`~@#&*+=、，。；：！？（）《》【】「」『』—…]/;

  // How well a name answers what was typed, and where it matched in the name
  // as given: 4 the whole name, 3 its start, 2 the start of a later word,
  // 1 anywhere, 0 not at all (case is ignored).
  function match(name, query) {
    const shown = text(name), q = fold(query);
    if (!q) return { score: 0, range: null };
    const lower = shown.toLowerCase();
    let at = lower.indexOf(q);
    if (at < 0) return { score: 0, range: null };
    let score = 1;
    if (lower.trim() === q) score = 4;
    else if (lower.trimStart().startsWith(q)) score = 3;
    else {
      // A later occurrence at a word start counts for more than an earlier one inside a word.
      for (let i = at; i >= 0; i = lower.indexOf(q, i + 1)) {
        if (i > 0 && BOUNDARY.test(lower[i - 1])) { score = 2; at = i; break; }
      }
    }
    if (score === 3) at = lower.length - lower.trimStart().length;
    const end = Math.min(shown.length, at + q.length);
    return { score, range: [at, end] };
  }

  const keyOf = (chat) => (chat ? (chat.type === "group" ? "group:" : "bot:") + text(chat.id) : "");

  // The chats in the sidebar's order (keys as keyOf gives them); any it does
  // not show keep their own order after those it does.
  function ordered(chats, order) {
    const at = new Map((order || []).map((key, i) => [key, i]));
    return (chats || [])
      .map((chat, i) => ({ chat, i, o: at.has(keyOf(chat)) ? at.get(keyOf(chat)) : Infinity }))
      .sort((a, b) => a.o - b.o || a.i - b.i)
      .map((x) => x.chat);
  }

  // For an empty query: the first chats of the sidebar, without the open one.
  function recent(chats, currentKey, limit = RECENT) {
    return (chats || []).filter((chat) => keyOf(chat) !== currentKey).slice(0, limit);
  }

  // The chats whose name (or, for a group, a member's name) holds the query,
  // best first; ties keep the given (sidebar) order. Each comes with the range
  // to mark in its name, or the member it answered for.
  function chats(list, query, limit = CHATS) {
    if (!fold(query)) return [];
    const found = [];
    (list || []).forEach((chat, i) => {
      const m = match(chat.name, query);
      if (m.score) { found.push({ chat, range: m.range, via: "", rank: m.score * 10, i }); return; }
      if (chat.type !== "group") return;
      const member = (chat.members || []).find((name) => match(name, query).score);
      if (member) found.push({ chat, range: null, via: text(member), rank: 1, i });
    });
    return found.sort((a, b) => b.rank - a.rank || a.i - b.i).slice(0, limit).map(({ chat, range, via }) => ({ chat, range, via }));
  }

  // The actions that apply here (when()) and answer the query by label or by
  // one of their words, best first; an empty query lists them all in order.
  function actions(list, query, ctx) {
    const usable = (list || []).filter((a) => {
      try { return !a.when || !!a.when(ctx || {}); } catch (e) { return false; }
    });
    if (!fold(query)) return usable.map((action) => ({ action, range: null }));
    const found = [];
    usable.forEach((action, i) => {
      const own = match(action.label, query);
      const word = Math.max(0, ...(action.keywords || []).map((k) => match(k, query).score));
      const rank = Math.max(own.score * 10, word * 10 - 5);
      if (rank > 0) found.push({ action, range: own.score ? own.range : null, rank, i });
    });
    return found.sort((a, b) => b.rank - a.rank || a.i - b.i).map(({ action, range }) => ({ action, range }));
  }

  // What may be sent to GET /search: empty (nothing to search), too long, or the trimmed words.
  function query(raw) {
    const q = text(raw).trim();
    if (!q) return { state: "empty", q: "" };
    if (q.length > MAX_QUERY) return { state: "long", q: "" };
    return { state: "ok", q };
  }

  // A scope as the app names a chat ({type, id}: a cat by name or native ID,
  // a group by ID), resolved against the chat list: the chat, and every ID a
  // search result may name it by. Null when there is no such chat.
  function scope(want, list) {
    if (!want || !want.id) return null;
    const type = want.type === "group" ? "group" : "bot", id = text(want.id);
    const chat = (list || []).find((c) => c.type === type && (text(c.id) === id || (type === "bot" && c.nativeId && text(c.nativeId) === id)));
    if (!chat) return null;
    return { type, chat, ids: [...new Set([text(chat.id), ...(type === "bot" && chat.nativeId ? [text(chat.nativeId)] : [])])] };
  }

  // Only the scoped chat's hits, in its current conversation.
  function scoped(results, sc) {
    if (!sc) return results || [];
    return (results || []).filter((hit) => hit && hit.chat && hit.chat.type === sc.type && sc.ids.includes(text(hit.chat.id)) && hit.current !== false);
  }

  // The chat a hit belongs to, as the app knows it (a cat's hit names its native ID).
  function chatOf(hit, list) {
    if (!hit || !hit.chat) return null;
    const id = text(hit.chat.id);
    return (list || []).find((c) => c.type === hit.chat.type && (text(c.id) === id || (c.type === "bot" && c.nativeId && text(c.nativeId) === id))) || null;
  }

  const hitKey = (hit) => text(hit && hit.threadId) + ":" + text(hit && hit.messageId);

  // Who said it, as the row's lead-in.
  const who = (hit) => (hit && hit.from === "owner" ? "你" : text(hit && hit.catName) || "猫猫");

  // The snippet cut where the server says the match is. Offsets that do not
  // fit the snippet mark nothing rather than the wrong words.
  function segments(snippet, range) {
    const s = text(snippet);
    const ok = Array.isArray(range) && range.length === 2 && Number.isInteger(range[0]) && Number.isInteger(range[1])
      && range[0] >= 0 && range[1] <= s.length && range[0] < range[1];
    if (!ok) return s ? [{ text: s, hit: false }] : [];
    return [{ text: s.slice(0, range[0]), hit: false }, { text: s.slice(range[0], range[1]), hit: true }, { text: s.slice(range[1]), hit: false }]
      .filter((part) => part.text);
  }

  // What a finished search says beyond its rows. Nothing found is said only
  // about what was read; unread conversations and anything not looked at or
  // not listed are said as such.
  //   data: the /search answer; shown: rows listed (after a scope);
  //   scopedTo: the scoped chat's name, if any.
  function notes(data, { q = "", shown = 0, scopedTo = "" } = {}) {
    const failed = Math.max(0, Number(data && data.failed) || 0);
    const more = !!(data && data.more);
    const total = Array.isArray(data && data.results) ? data.results.length : 0;
    const where = scopedTo ? "这段对话里" : "";
    const out = { empty: "", failed: "", more: "" };
    if (!shown) out.empty = failed ? "能读到的对话里没有找到「" + q + "」。" : (where || "聊过的话里") + "没有找到「" + q + "」。";
    if (failed) out.failed = "有 " + failed + " 个对话暂时读不到，没能在里面找" + (shown ? "，结果可能不全。" : "。");
    if (more) {
      if (total >= LIMIT) out.more = scopedTo ? "只看了所有聊天里最新的 " + LIMIT + " 条，这段对话里可能还有。" : "只列出了最新的 " + LIMIT + " 条，可能还有更多。";
      else out.more = "只搜了最近的消息，更早的里可能还有。";
    }
    return out;
  }

  const pad = (n) => String(n).padStart(2, "0");
  // When a message was said, short: the time today, 昨天, the date this
  // year, the full date before.
  function stamp(iso, now = new Date()) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return "";
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((day(now) - day(d)) / 86400000);
    if (days === 0) return pad(d.getHours()) + ":" + pad(d.getMinutes());
    if (days === 1) return "昨天";
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + "月" + d.getDate() + "日";
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }

  // The next row for ↑/↓ among count rows, wrapping round; -1 when there are none.
  function move(count, index, delta) {
    if (!count) return -1;
    if (index < 0 || index >= count) return delta > 0 ? 0 : count - 1;
    return (index + delta + count) % count;
  }

  // Alt+↑ / Alt+↓: the chat before or after the open one in the sidebar's
  // order (keys), not wrapping. With none open, ↓ takes the first and ↑ the last.
  function neighbor(order, currentKey, dir) {
    const list = order || [];
    if (!list.length) return "";
    const at = list.indexOf(currentKey);
    if (at < 0) return dir > 0 ? list[0] : list[list.length - 1];
    const next = at + (dir > 0 ? 1 : -1);
    return next >= 0 && next < list.length ? list[next] : "";
  }

  // A key press the page answers anywhere: "palette" (⌘K on macOS, Ctrl+K
  // elsewhere), "prev" / "next" (Alt+↑ / Alt+↓), or "" for anything else.
  // Shortcuts the browser keeps (⌘N, ⌘1–9 …) are never claimed.
  function shortcut(ev, mac) {
    if (!ev || ev.isComposing || ev.keyCode === 229) return "";
    const k = text(ev.key).toLowerCase();
    if ((k === "k" || ev.code === "KeyK") && !ev.altKey && !ev.shiftKey && (mac ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && !ev.metaKey)) return "palette";
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
      if (ev.key === "ArrowUp") return "prev";
      if (ev.key === "ArrowDown") return "next";
    }
    return "";
  }

  window.ClowderPaletteRules = Object.freeze({
    MAX_QUERY, LIMIT, DEBOUNCE, RECENT, CHATS,
    match, keyOf, ordered, recent, chats, actions, query, scope, scoped, chatOf, hitKey, who, segments, notes, stamp, move, neighbor, shortcut,
  });
})();
