// Rules for the guide to what clowder-bot can do (showcase/tour.js), without
// DOM or network (classic script, window.ClowderTourRules); tests load the
// same file.
(() => {
  "use strict";

  // ---- What is behind the page ----
  // Only the scripted preview answers GET /__preview, and only its showcase,
  // with the chats staged, is "the staged chats are running". Anything else
  // (the plain preview, a real instance, no answer) is not.
  const staged = (id) => !!id && typeof id === "object" && id.preview === true && id.scene === "showcase" && id.staged === true;
  // The chats with a demo line (POST /__preview {"play": name} answers 404 for the rest).
  const plays = (id) => new Set(staged(id) && Array.isArray(id.plays) ? id.plays.filter((n) => typeof n === "string") : []);

  // ---- One contact row ----
  // What a row shows from one status entry (GET /xbot-api/bots/status), worded
  // by the product's own chat-list-rules.js (R). null when the entry's
  // activity was not read whole (readStatus other than "ready": unread, counts
  // and the latest line are then placeholders): the row keeps what it showed,
  // because a failed read is not "nothing is waiting".
  function rowView(entry, group, R, now) {
    const a = entry && typeof entry === "object" ? entry.activity : null;
    if (!a || typeof a !== "object" || a.readStatus !== "ready") return null;
    const counts = a.counts && typeof a.counts === "object" ? a.counts : {};
    const l = R.last(entry), u = R.unread(entry);
    const busy = (Number(counts.running) || 0) > 0 || (Array.isArray(a.active) && a.active.length > 0);
    const waiting = (Number(counts.approval) || 0) > 0 || entry.state === "awaiting";
    return {
      time: l ? R.ago(l.time, now) : "",
      iso: l ? new Date(l.time).toISOString() : "",
      stamp: l ? R.stamp(l.time) : "",
      line: busy ? "busy" : waiting ? "waiting" : "said",
      said: R.preview(l, group),
      badge: R.badge(u),
      dot: u.n > 0,
    };
  }

  // ---- Reading again, one read at a time ----
  // run({signal, current}) reads and paints. A call while a read is running
  // asks for one more after it (never two in flight, never a pile of them);
  // nothing runs while the page is hidden; a read is given up after `ms`
  // (its signal aborts and the next call may start), and current() is false
  // once the read was given up or reset() was called, so an answer that
  // arrives late is never painted over a newer one.
  function serial(run, opts = {}) {
    const ms = opts.ms || 6000;
    const visible = opts.visible || (() => true);
    const later = opts.setTimeout || setTimeout, cancel = opts.clearTimeout || clearTimeout;
    const Abort = opts.AbortController || AbortController;
    let busy = null, again = false, epoch = 0;
    function go() {
      const mine = ++epoch, ctl = new Abort();
      const current = () => mine === epoch && !ctl.signal.aborted;
      let timer = 0;
      const gaveUp = new Promise((done) => { timer = later(() => { ctl.abort(); done(); }, ms); });
      const work = Promise.resolve().then(() => run({ signal: ctl.signal, current })).catch(() => {});
      busy = Promise.race([work, gaveUp]).then(() => {
        cancel(timer);
        busy = null;
        if (again) { again = false; refresh(); }
      });
      return busy;
    }
    function refresh() {
      if (!visible()) return Promise.resolve();
      if (busy) { again = true; return busy; }
      return go();
    }
    return { refresh, reset() { epoch++; again = false; }, running: () => !!busy };
  }

  window.ClowderTourRules = Object.freeze({ staged, plays, rowView, serial });
})();
