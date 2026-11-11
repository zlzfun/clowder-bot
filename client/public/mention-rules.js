// 群聊里的 @ · 规则层：没有 DOM，也没有网络。mention.js 和测试共用。
// Which mention is being typed at the caret, which of the group's members (and
// 「全体」) it can become, and the text after picking one. The draft is sent
// as it is: the engine reads `@名字` and routes it; nothing here routes.
//
// The engine's own @全体 / @all reaches every cat the owner has, not the
// group's members (the others are refused one by one in the chat), so 「全体」
// here writes one explicit mention per member: `@快手 @墨点 `.
(function (root) {
  "use strict";

  // A name may hold spaces (宪宪 2); a query is at most this long.
  const MAX_QUERY = 32;
  // @ typed with a Chinese input method can arrive full-width.
  const AT = /[@＠]/;
  // Part of a word or an address (a@b.com): not a mention.
  const WORDISH = /[\p{L}\p{N}_.\-]/u;
  const ALL = Object.freeze({ kind: "all", label: "全体", hint: "@ 群里每一只", keys: Object.freeze(["全体", "all", "大家", "所有"]) });

  // The mention the caret is in: {start, end, query}, or null.
  function active(text, caret) {
    text = String(text == null ? "" : text);
    if (typeof caret !== "number" || caret < 0 || caret > text.length) return null;
    let at = -1;
    for (let i = caret - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === "\n") return null;
      if (AT.test(ch)) { at = i; break; }
    }
    if (at < 0) return null;
    if (at > 0 && WORDISH.test(text[at - 1])) return null;
    const query = text.slice(at + 1, caret);
    if ([...query].length > MAX_QUERY) return null;
    return { start: at, end: caret, query };
  }

  const lower = (s) => String(s).toLowerCase();
  // The members (names, in the group's order) the query can become: names
  // that start with it first, then names that contain it, then 「全体」 when
  // the group has two or more and the query fits one of its words. A query
  // that fits nothing (an email's tail, a sentence after @) gives none.
  function suggest(query, names) {
    const list = [...new Set((names || []).map(String).filter(Boolean))];
    const q = lower(query || "");
    const first = list.filter((n) => lower(n).startsWith(q));
    const then = q ? list.filter((n) => !first.includes(n) && lower(n).includes(q)) : [];
    const out = [...first, ...then].map((name) => ({ kind: "cat", name }));
    if (list.length >= 2 && (!q || ALL.keys.some((k) => lower(k).startsWith(q)))) out.push(ALL);
    return out;
  }

  // Whether `@name` already stands in the text as a mention of its own.
  function mentioned(text, name) {
    const mark = "@" + name;
    for (let i = text.indexOf(mark); i >= 0; i = text.indexOf(mark, i + 1)) {
      const before = i > 0 ? text[i - 1] : "", after = text[i + mark.length] || "";
      if ((!before || !WORDISH.test(before)) && (!after || !WORDISH.test(after))) return true;
    }
    return false;
  }
  // The draft after picking: the typed `@query` becomes `@名字 ` (or one
  // mention per member not already mentioned elsewhere, for 「全体」), with
  // one space after it unless one is already there; the caret lands after it.
  function insert(text, at, item, names) {
    text = String(text == null ? "" : text);
    const before = text.slice(0, at.start), after = text.slice(at.end);
    const rest = before + after;
    const targets = item && item.kind === "all"
      ? [...new Set((names || []).map(String))].filter((n) => !mentioned(rest, n))
      : [String(item && item.name)];
    const mention = targets.map((n) => "@" + n).join(" ");
    if (!mention) return { text: rest, caret: before.length };
    const spaced = /^[ \t 　]/.test(after);
    return { text: before + mention + (spaced ? "" : " ") + after, caret: before.length + mention.length + 1 };
  }

  root.ClowderMentionRules = Object.freeze({ MAX_QUERY, ALL, active, suggest, mentioned, insert });
})(typeof window !== "undefined" ? window : globalThis);
