// Finding one message of the open chat when it is further back than the
// loaded history (classic script, window.ClowderLocateRules). No DOM and no
// network: chat-locate.js asks these rules what to do next and what to say,
// and tests load the same file.
//
// The earlier pages are the history's own (chat-history.js, the existing
// GET …/transcript?before= and GET /xbot-api/groups/:id?before=); nothing here
// reads, stores or indexes messages. A search is bounded: a few page requests
// in all (the history's own reading through empty pages included), then a
// truthful stop that says how far it looked.
(() => {
  "use strict";
  // Earlier-page requests one search may cause at most (a page is up to 200 native messages).
  const MAX_PAGES = 10;

  // A history row is the target by its native message ID (search results, the
  // status line) or by its seq (a quote's reply_to). A reaction is drawn on a
  // row rather than as one: the row that carries it (its IDs in data-rx, its
  // numbers in data-rxs, chat-reactions.js) is where it is found.
  const listed = (list, v) => String(list || "").split(" ").includes(String(v));
  function matches(row, target) {
    if (!row || !row.dataset || !target) return false;
    if (target.messageId && (row.dataset.mid === String(target.messageId) || listed(row.dataset.rx, target.messageId))) return true;
    return target.seq != null && target.seq !== "" && (row.dataset.seq === String(target.seq) || listed(row.dataset.rxs, target.seq));
  }

  // What to do now: { act: "found" } | { act: "load" } | { act: "stop", why }.
  // s: { found, pages (earlier-page requests sent since this search began,
  // whoever sent them), failed (one of those failed), more (the history has an
  // earlier page), state ("idle" | "loading" | "failed" | "end"), alive (the
  // same chat, conversation and request as when it began), stalled (the last
  // attempt changed nothing) }.
  function next(s) {
    if (!s || !s.alive) return { act: "stop", why: "left" };
    if (s.found) return { act: "found" };
    if (s.failed) return { act: "stop", why: "failed" };
    // A page on its way (ours or the owner's scroll): wait for it; the cap keeps
    // the history from sending more than the budget meanwhile.
    if (s.state === "loading") return { act: "load" };
    if (!s.more) return { act: "stop", why: s.pages > 0 ? "end" : "none" };
    if (s.pages >= MAX_PAGES) return { act: "stop", why: "limit" };
    if (s.stalled) return { act: "stop", why: "stuck" };
    return { act: "load" };
  }

  // The quiet note while it looks, and the one it stops with ("" says nothing:
  // the owner went to another chat or conversation, or a newer search took over).
  function progress(pages) {
    return pages > 0 ? "正在往前找这条消息…已经翻了 " + pages + " 页" : "正在往前找这条消息…";
  }
  function stopped(why, pages, error) {
    const reason = String(error || "").replace(/^没能完成：/, "").replace(/[。.]+$/, "");
    if (why === "none") return "这条消息不在这段对话里，也没有更早的记录可以翻了。";
    if (why === "end") return "翻到了这段对话最早的消息，也没有找到这一条。";
    if (why === "limit") return "往前翻了 " + pages + " 页还没找到这条消息，先停在这里；可以接着往上翻看。";
    if (why === "failed") return "没能加载更早的消息" + (reason ? "：" + reason : "") + "。这条消息还没找到。";
    if (why === "undrawn") return "更早的消息读到了，但还没能显示出来，这条消息还没找到；稍后再找一次。";
    if (why === "stuck") return "没能再往前翻，这条消息还没找到。";
    return "";
  }

  window.ClowderLocateRules = Object.freeze({ MAX_PAGES, matches, next, progress, stopped });
})();
