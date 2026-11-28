// 应用 · 规则层：没有 DOM，也没有网络。apps-dialog.js 和测试共用。
// The 应用 dialog (docs/xbot-frontend.md item 54) over the adapter's routes
// (docs/apps-api.md): GET/POST/PATCH/DELETE /xbot-api/apps…. Here: what each
// state is called and drawn as, what can be done in it, the starting poll and
// the authorization countdown, the custom-app form's checks (mirroring the
// adapter's own: server/native/apps.ts) and the same checks for a program,
// its arguments or an address changed in place (item 60), which cats are
// shown with their switches, the idempotency fingerprint, what a failed
// request says, and the words (docs/apps-api.md 「界面怎么说」: in
// front of a button only what a person would be misled without; the rest of
// what is true one click away).
// The word MCP appears only in the custom-app form's one line: everyone else
// meets an app by its name.
(function (root) {
  "use strict";

  const trim = (value) => String(value == null ? "" : value).trim();
  const han = (text) => /\p{Script=Han}/u.test(String(text || ""));
  // zod counts characters (code points), not UTF-16 units.
  const length = (text) => [...String(text)].length;
  // A server sentence is shown only when it is everyday Chinese without the engine's words.
  const plain = (text) => han(text) && !/(?<![\w-])bots?\b|\bmodel\b|\bsessions?\b|\bthreads?\b|模型|原生|会话|线程|clowder ai/i.test(String(text));
  const stop = (text) => (/[。！？）」]$/u.test(text) ? text : text + "。");

  // ---- where ----
  const WECHAT = "wechat";
  // custom:<native id>: the colon is escaped in the path.
  const path = (id) => "/xbot-api/apps/" + encodeURIComponent(String(id));

  // ---- what a state is called, and its mark ----
  // Marks, never colour alone (apps-dialog.css): on — a filled dot; bad — an
  // outlined ring; busy — the status spinner; idle — a short bar; off — a
  // struck ring. The word always comes with it.
  // 微信 as the list answers it when its state could not be read (docs/apps-api.md): not a thing this
  // computer lacks, so it is not drawn as unusable, and reading it again can help.
  const UNREAD = "没能读到它的状态";
  const unread = (app) => !!app && app.kind === "wechat" && app.state === "unavailable" && trim(app.reason) === UNREAD;
  // check: "running" while a check of this custom app is on its way, else "".
  // 微信 on is 已打开 whether or not the ten-minute authorization is running: that authorization
  // covers only reading the chat open in 微信, never whether cats can read at all (docs/apps-api.md
  // 「两种读法」); the list row adds its time left, named as the authorization's.
  function look(app, check) {
    if (!app) return { mark: "idle", word: "" };
    const reason = trim(app.reason);
    if (app.kind === "wechat") {
      if (app.state === "starting") return { mark: "busy", word: "正在启动…" };
      if (app.state === "on") return { mark: "on", word: "已打开" };
      if (app.state === "failed") return { mark: "bad", word: reason || "没能启动" };
      if (unread(app)) return { mark: "idle", word: UNREAD };
      if (app.state === "unavailable") return { mark: "off", word: reason || "现在用不了" };
      return reason ? { mark: "bad", word: reason } : { mark: "idle", word: "未打开" };
    }
    if (check === "running") return { mark: "busy", word: "正在检查…" };
    if (app.state === "on") return { mark: "on", word: "已连接" };
    if (app.state === "failed") return { mark: "bad", word: reason || "没有回应" };
    if (app.state === "off") return { mark: "off", word: reason || "已停用" };
    return { mark: "idle", word: reason || "未检查" };
  }

  // ---- 微信 ----
  // What can be done in each state, at the top by the state; nothing that cannot work (unavailable: nothing).
  // gaveUp: the starting poll stopped after about two minutes (or a read failed): a manual re-read.
  // said: the button's name for a screen reader, which holds the word shown (the dialog's × is 关闭 too).
  function wechatActions(app, gaveUp) {
    if (!app) return [];
    const open = (label) => ({ act: "connect", label, said: label === "打开" ? "打开微信" : "再试一次打开微信", main: true });
    const shut = { act: "disconnect", label: "关闭", said: "关闭微信", main: false };
    const reread = { act: "reread", label: "再看一次", said: "再看一次微信现在的状态", main: false };
    if (app.state === "off") return [open(trim(app.reason) ? "再试一次" : "打开")];
    if (app.state === "starting") return gaveUp ? [reread] : [];
    if (app.state === "on") return [shut];
    if (app.state === "failed") return [shut, open("再试一次")];
    if (unread(app)) return [reread];
    return [];
  }
  const BUSY = { connect: "正在打开…", disconnect: "正在关闭…", authorize: "正在授权…", revoke: "正在撤销…", reread: "正在读取…", check: "正在检查…" };
  // While 微信 is starting it is read again about every 2 s; after about 2 minutes the reads stop.
  const POLL_EVERY = 2000, POLL_FOR = 120000;
  // The wait before the next read, or -1: stop (still say it is starting, offer a manual re-read).
  const pollNext = (started, at) => (at + POLL_EVERY - started > POLL_FOR ? -1 : POLL_EVERY);
  // When the authorization ends, as an instant on this page's clock: the server's `until`, unless this
  // computer's clock disagrees with the server's own remaining time by more than 5 s — then the
  // remaining time counted from when it was read. Never from a click.
  function deadline(auth, readAt) {
    if (!auth || !auth.active) return null;
    const left = Number(auth.remaining_ms);
    const byLeft = Number.isFinite(left) ? readAt + Math.max(0, left) : null;
    const until = Date.parse(auth.until || "");
    if (Number.isFinite(until) && (byLeft === null || Math.abs(until - byLeft) <= 5000)) return until;
    return byLeft;
  }
  // 9:41 (minutes:seconds), counted up to the next whole second so 0:00 is the end itself.
  function clock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  // The same for a screen reader: 还剩 9 分 41 秒.
  function clockSaid(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000)), m = Math.floor(s / 60), r = s % 60;
    return "还剩 " + (m ? m + " 分" + (r ? " " + r + " 秒" : "") : r + " 秒");
  }
  // When the shown clock next changes.
  const tickIn = (ms) => { const r = ms % 1000; return ms <= 0 ? 0 : r === 0 ? 1000 : r; };

  // The words around 微信 (docs/apps-api.md 「微信」: 「两种读法」, 「界面怎么说」). A cat reads 微信 in two ways:
  //   by name — a contact whose name matches exactly: needs only 微信 to be open, until 关闭 (no other switch,
  //     no time limit; nothing makes the cat ask first); it brings 微信 to the front, may mark that chat read;
  //   the open chat — the chat open in 微信 now: needs 微信 open AND the plugin's ten-minute authorization.
  // In front of 打开 (and 再试一次) only the one thing a person would be misled without: opening is what lets
  // cats read by name (otherwise the ten minutes look like the gate of all reading). Once open, the layout says
  // the rest: the two ways as two rows, each its own state and control. Everything else is behind 说明.
  // Never said: that a cat asks first; that cats cannot read for want of the ten minutes; that macOS will ask.
  const WECHAT_LEAD = "打开后，猫猫可以按联系人的名字读这台 Mac 上的微信，直到你关闭。";
  // The two rows, and their states (a mark and a word, as everywhere in the dialog).
  const BY_NAME = "按名字读联系人";
  const BY_NAME_ON = "可用";
  const OPEN_CHAT = "读微信里正打开的那段聊天";
  const OPEN_OFF = "未授权";
  const OPEN_LEFT = "授权还剩";
  // 微信 on without an `authorization` field (or its last read failed): unknown, never "not authorized".
  const OPEN_UNKNOWN = "没能读到授权状态";
  const authKnown = (app) => !!app && app.state === "on" && !!app.authorization && typeof app.authorization === "object";
  // 说明: the one place for the rest, collapsed until asked for. The second line names both places the text goes
  // (the Agent and its model): where the owner's 微信 text ends up outranks the everyday-words rule
  // (tests/vocabulary.test.ts, CONSENT) — it is word for word the sentence that rule excepts.
  const MORE = "说明";
  const WECHAT_NOTES = Object.freeze([
    "只读：不发消息、不点链接，也不读聊天记录库；截图认字，截图不保存。",
    "认出的文字会和你发给猫猫的话一样，交给它用的 Agent 和模型，并留在那段聊天的执行记录里。",
    "按名字读时，微信会短暂切到前面，那段聊天可能被标为已读，读完尽量复原。",
    // The plugin checks screen recording and never asks; the entry is the program that started clowder-bot
    // (not named: which one depends on how it was started).
    "需要在 系统设置 › 隐私与安全性 里给启动 clowder-bot 的程序打开「屏幕录制」，按名字读还要「辅助功能」；没有的话，猫猫会说没能读到。",
    // A cat refused for want of the ten minutes repeats the plugin's words, which name its upstream screen.
    "猫猫提到「Plugin Hub」时，指的就是这里。",
  ]);
  // The plugin's own words, quoted with their version; where they say reading by contact is authorized each
  // time, one line of ours says what is true (两种读法: nothing asks each time; the cat confirms by itself).
  const sourceLabel = (version) => "插件原文" + (trim(version) ? " · " + trim(version) : "");
  const SOURCE_NOTE = "其中说按联系人读取要逐次授权，其实不会每次问你：按名字读时是猫猫自己确认的。";
  const sourceNote = (disclosure) => (/逐次授权/.test(String(disclosure || "")) ? SOURCE_NOTE : "");
  // Starting: a first start can take long enough to look stuck; after about two minutes the reads stop.
  const WECHAT_SLOW = "第一次可能要半分钟以上。";
  const WECHAT_STILL = "已经两分钟了，还在启动。";
  // Said once to a screen reader, for what happened while the owner was not acting.
  const SAID = Object.freeze({
    started: "微信已经打开了。",
    startFailed: (reason) => "微信没能启动" + (trim(reason) ? "：" + trim(reason) : "") + "。",
    still: "微信还在启动。",
    ended: "微信的 10 分钟授权结束了，按名字读不受影响。",
  });

  // ---- 自定义应用: the form ----
  // The adapter's limits (server/native/apps.ts): name 1–40; program 1–512; at most 32 arguments of at
  // most 2048 each; the address https:// (http:// only for this computer) without a user or password,
  // at most 2048; at most 32 secrets, a value 1–8192 without a line break; a program's secrets are
  // environment variables, an address's are request headers, each with its own rule for names.
  const NAME_MAX = 40, PROGRAM_MAX = 512, ARGS_MAX = 32, ARG_MAX = 2048, URL_MAX = 2048, SECRETS_MAX = 32, VALUE_MAX = 8192;
  const MASK = "••••••";
  const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
  const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
  const LOCAL = ["localhost", "127.0.0.1", "[::1]"];
  const URL_SAID = "网址需要以 https:// 开头（本机地址可以用 http://），且不带用户名密码";
  const SECRETS_WORD = { program: "环境变量", url: "请求头" };

  function nameProblem(value) {
    const v = trim(value);
    if (!v) return "给它起个名字吧";
    if (length(v) > NAME_MAX) return "名字最多 " + NAME_MAX + " 个字";
    return "";
  }
  function programProblem(value) {
    const v = trim(value);
    if (!v) return "填上要运行的程序";
    if (length(v) > PROGRAM_MAX) return "程序最多 " + PROGRAM_MAX + " 个字";
    if (/[\0\r\n]/.test(v)) return "程序里不能有换行";
    return "";
  }
  // Arguments, one per line: each line as written, without its surrounding spaces; blank lines are not arguments.
  const argsOf = (text) => String(text == null ? "" : text).split(/\r?\n/).map(trim).filter(Boolean);
  function argsProblem(list) {
    if (list.length > ARGS_MAX) return "参数最多 " + ARGS_MAX + " 个";
    const at = list.findIndex((a) => length(a) > ARG_MAX || /\0/.test(a));
    return at >= 0 ? "第 " + (at + 1) + " 个参数太长了（最多 " + ARG_MAX + " 个字）" : "";
  }
  function urlProblem(value) {
    const v = trim(value);
    if (!v) return "填上网址";
    if (length(v) > URL_MAX) return "网址最多 " + URL_MAX + " 个字";
    try {
      const u = new URL(v);
      if (u.username || u.password) return URL_SAID;
      if (u.protocol === "https:" || (u.protocol === "http:" && LOCAL.includes(u.hostname))) return "";
    } catch { /* not an address */ }
    return URL_SAID;
  }
  function secretNameProblem(name, kind) {
    const v = trim(name);
    if (!v) return "填上名称";
    if (kind === "url") return HEADER_NAME.test(v) ? "" : "请求头的名称只能用字母、数字和 - _ 这类符号，不能有空格";
    return ENV_NAME.test(v) ? "" : "变量名只能用字母、数字和下划线，不能以数字开头";
  }
  // replacing: an existing secret's new value (it cannot be emptied: the engine has no way to drop one).
  const EMPTY_SECRET = "值不能留空。要去掉这一项，只能移除这个应用再重新添加。";
  function secretValueProblem(value, replacing) {
    const v = trim(value);
    if (!v) return replacing ? EMPTY_SECRET : "填上值，或者删掉这一行";
    if (length(v) > VALUE_MAX) return "值最多 " + VALUE_MAX + " 个字";
    if (/[\0\r\n]/.test(v) || v.includes(MASK)) return "这个值不能用";
    return "";
  }
  // The rows as written: a row left empty is no secret; names twice are one problem (headers ignore case).
  function secretsOf(rows, kind) {
    const secrets = {}, problems = [], seen = new Set();
    const list = (rows || []).map((r) => ({ name: trim(r && r.name), value: trim(r && r.value) }));
    list.forEach((r, at) => {
      if (!r.name && !r.value) return;
      const nameBad = secretNameProblem(r.name, kind), valueBad = secretValueProblem(r.value, false);
      const key = kind === "url" ? r.name.toLowerCase() : r.name;
      if (nameBad) problems.push({ field: "secret-name", row: at, text: nameBad });
      else if (seen.has(key)) problems.push({ field: "secret-name", row: at, text: "名称重复了" });
      if (valueBad) problems.push({ field: "secret-value", row: at, text: valueBad });
      seen.add(key);
      if (!nameBad && !valueBad) secrets[r.name] = r.value;
    });
    if (Object.keys(secrets).length > SECRETS_MAX) problems.push({ field: "secrets", text: "最多 " + SECRETS_MAX + " 项" });
    return { secrets, problems };
  }
  // The form → the request body, and every problem in the order of the form.
  // form: {name, kind: "program" | "url", program, args (the text, one per line), url, secrets: {program: rows, url: rows}}
  function check(form) {
    const f = form || {}, kind = f.kind === "url" ? "url" : "program", problems = [];
    const name = trim(f.name), np = nameProblem(name);
    if (np) problems.push({ field: "name", text: np });
    const rows = (f.secrets && f.secrets[kind]) || [];
    let body;
    if (kind === "url") {
      const up = urlProblem(f.url);
      if (up) problems.push({ field: "url", text: up });
      const s = secretsOf(rows, "url");
      problems.push(...s.problems);
      body = { name, url: trim(f.url), secrets: s.secrets };
    } else {
      const pp = programProblem(f.program), args = argsOf(f.args), ap = argsProblem(args);
      if (pp) problems.push({ field: "program", text: pp });
      if (ap) problems.push({ field: "args", text: ap });
      const s = secretsOf(rows, "program");
      problems.push(...s.problems);
      body = { name, program: trim(f.program), args, secrets: s.secrets };
    }
    return { body, problems };
  }
  function fingerprint(value) {
    if (Array.isArray(value)) return "[" + value.map(fingerprint).join(",") + "]";
    if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + fingerprint(value[k])).join(",") + "}";
    return JSON.stringify(value === undefined ? null : value);
  }
  // The same thing to check: program or address, its arguments, and the names of its secrets.
  const sameSource = (a, b) => fingerprint(a || null) === fingerprint(b || null);

  // ---- 自定义应用: what it is, changed in place ----
  // The editor's fields (program, and the arguments one per line; or the address) against the source the server
  // answered → the PATCH body with only what changed (the adapter keeps the rest: arguments the owner did not
  // touch are never rewritten), whether anything changed at all (nothing: the editor just closes), and every
  // problem in the order of the fields — the same checks as the add form, which are the adapter's.
  // source: the app's `source`; form: {program, args (the text), url}.
  function sourceChange(source, form) {
    const src = source || {}, f = form || {}, problems = [], body = {};
    if (src.type === "url") {
      const url = trim(f.url), up = urlProblem(url);
      if (up) problems.push({ field: "url", text: up });
      if (url !== trim(src.url)) body.url = url;
    } else {
      const program = trim(f.program), args = argsOf(f.args), pp = programProblem(program), ap = argsProblem(args);
      if (pp) problems.push({ field: "program", text: pp });
      if (ap) problems.push({ field: "args", text: ap });
      if (program !== trim(src.program)) body.program = program;
      // As written in the editor, the old arguments read one per line too.
      if (fingerprint(args) !== fingerprint(argsOf((Array.isArray(src.args) ? src.args : []).join("\n")))) body.args = args;
    }
    return { body, changed: Object.keys(body).length > 0, problems };
  }
  // Who may use it: the cats the server answered (absent: not known, so not shown), while it is not turned off —
  // turned off, no cat can, and turning it on again gives it back to every cat (upstream's own rule).
  const catsOf = (app) => (app && app.kind === "custom" && app.state !== "off" && Array.isArray(app.cats) ? app.cats.filter((c) => c && trim(c.name)) : []);
  // The app turned off or on (PUT …/enabled): the control at the top, by the state; while it is on its way, what it is doing.
  const toggleLabel = (app, busy) => (busy ? (busy.on ? "正在启用…" : "正在停用…") : app && app.state === "off" ? "启用" : "停用");

  // A whole command line pasted where the program goes, split for the owner — only when the split is
  // the one a shell would make and nothing else could be meant: words and quotes, no pipes, redirections,
  // substitutions or leading NAME=value, more than one word, and not a lone path (a path pasted from
  // Finder may hold spaces). null: leave it as pasted.
  function splitCommand(text) {
    const s = String(text == null ? "" : text).replace(/\\\r?\n/g, " ").trim();
    if (!s || !/\s/.test(s)) return null;
    const words = [];
    let cur = "", has = false, i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "'") {
        const end = s.indexOf("'", i + 1);
        if (end < 0) return null;
        cur += s.slice(i + 1, end); has = true; i = end + 1; continue;
      }
      if (c === '"') {
        let j = i + 1, part = "";
        for (; j < s.length && s[j] !== '"'; j++) {
          if (s[j] === "\\" && j + 1 < s.length && /["\\$`]/.test(s[j + 1])) { part += s[j + 1]; j++; continue; }
          if (s[j] === "$" || s[j] === "`") return null;
          part += s[j];
        }
        if (j >= s.length) return null;
        cur += part; has = true; i = j + 1; continue;
      }
      if (c === "\\") { if (i + 1 >= s.length) return null; cur += s[i + 1]; has = true; i += 2; continue; }
      if (/[|&;<>()$`]/.test(c)) return null;
      if (/\s/.test(c)) { if (has) { words.push(cur); cur = ""; has = false; } i++; continue; }
      cur += c; has = true; i++;
    }
    if (has) words.push(cur);
    if (words.length < 2) return null;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return null;
    if (/^(\/|~\/)/.test(s) && !words.slice(1).some((w) => w.startsWith("-"))) return null;
    return words;
  }
  // The program and its arguments as one line to read: an argument with spaces or quotes is quoted.
  function commandLine(program, args) {
    const q = (w) => (w === "" ? "''" : /[\s'"\\$`|&;<>()]/.test(w) ? "'" + w.replace(/'/g, "'\\''") + "'" : w);
    return [program, ...(args || [])].map((w) => q(String(w))).join(" ");
  }
  // A server that downloads itself the first time it runs can miss the few seconds a check waits.
  const FETCHERS = new Set(["npx", "uvx", "bunx", "pnpx", "pnpm", "pipx", "docker", "yarn"]);
  function slowFirstRun(app) {
    const src = app && app.source;
    if (!app || app.state !== "failed" || trim(app.reason) !== "几秒内没有回应" || !src || src.type !== "program") return false;
    return FETCHERS.has(String(src.program || "").split("/").pop());
  }

  // The form's one line: without MCP, 网址 reads as "add a website". The only place the word appears.
  const CUSTOM_LEAD = "接入一个 MCP 服务。";
  // In front of 添加 (docs/apps-api.md「范围与确认」): what a person would be misled without — every cat, unasked.
  const ADD_SCOPE = "所有猫猫都能用它，用的时候不会先问你。";
  // Next to the secrets, once there is one: how they are kept.
  const SECRETS_KEPT = "值会原样存在这台电脑上，不加密。";
  // What an add answered: 201 is added, whatever its state. On the page the state line says how it is (so the
  // note only says it is in); said to a screen reader after the owner left the form, the state comes with it.
  function added(app, said) {
    if (app && app.state === "on") return "加好了。";
    if (!said) return "已经加上了。";
    return app && app.state === "failed" ? "已经加上了，但它没有回应。" : "已经加上了，但没能检查它。";
  }
  const SLOW_HINT = "第一次运行要先下载，稍后再试一次。";
  const REMOVE_NOTE = "移除后不能恢复，猫猫从下一条消息起就用不了它。";
  const removeTitle = (name) => "移除「" + trim(name) + "」？";

  // ---- answers ----
  // The server's 4xx sentence as it said it, without the field's path a validation puts before it
  // ("url: 网址需要…"); "" when it is not everyday Chinese.
  function sentence(err) {
    const raw = String((err && err.message) || "").replace(/\s+/g, " ").trim();
    const said = raw.split("；").map((p) => p.replace(/^[A-Za-z_][\w.[\]]*:\s*/, "").trim()).filter(Boolean).join("；");
    return said && plain(said) ? stop(said) : "";
  }
  const unsure = (err) => !err || !err.status || err.status >= 500;
  // Why it failed, briefly, when the server said nothing that can be shown.
  const why = (err) => (!err || !err.status ? "连不上 clowder-bot" : err.status >= 500 ? "服务出了点问题" : "");
  const failed = (what, err) => what + (why(err) ? "：" + why(err) : "") + "，稍后再试。";
  const ADD_UNSURE = "没能确认加上了没有。不改内容再点一次「添加」就好，不会多加一个。";
  function addError(err) {
    if (unsure(err)) return { kind: "unsure", text: ADD_UNSURE };
    return { kind: "form", text: sentence(err) || "没能添加，请检查填写的内容。" };
  }
  const WECHAT_FAILED = { connect: "没能打开微信", disconnect: "没能关闭微信", authorize: "没能授权", revoke: "没能撤销", reread: "没能读到微信现在的状态" };
  // A 409 that says it is not on (or cannot be) leads to a fresh read; every failed write is followed by one.
  function wechatError(err, act) {
    const what = WECHAT_FAILED[act] || "没能完成";
    if (err && (err.code === "app_not_on" || err.code === "app_unavailable")) return { kind: "reread", text: sentence(err) || stop(what) };
    if (unsure(err)) return { kind: "unsure", text: failed(what, err) };
    return { kind: "form", text: sentence(err) || stop(what) };
  }
  function checkError(err) {
    if (err && err.status === 404) return { kind: "gone", text: "它已经不在了。" };
    return { kind: unsure(err) ? "unsure" : "form", text: unsure(err) ? failed("没能检查", err) : sentence(err) || "没能检查，稍后再试。" };
  }
  // what: "rename" | "secret" | "source" (program, arguments or address) | "toggle" (the app turned off or on: on,
  // what was asked for) | "cat" (one cat's switch: on, what was asked for; who, the cat).
  // gone: 404 — for a cat's switch, the app or the cat (the list read after it says which).
  // disabled: 409 app_disabled — the app was turned off meanwhile; no cat's switch works until it is on again, and a
  // program's app does not take a new program or arguments (the engine would start it to take them).
  // unsure: the answer was lost — it may have been done; the same request again is safe (the same thing is asked for).
  function patchError(err, what, on, who) {
    if (err && err.status === 404) return { kind: "gone", text: "它已经不在了。" };
    if ((what === "cat" || what === "source") && err && err.code === "app_disabled") return { kind: "disabled", text: sentence(err) || "它已经停用了，先启用它。" };
    const cat = "「" + trim(who) + "」";
    if (unsure(err)) {
      const text = what === "rename" ? "没能确认改好了没有，可以再试一次。"
        : what === "toggle" ? "没能确认" + (on ? "启用" : "停用") + "了没有，可以再试一次。"
        : what === "cat" ? "没能确认" + cat + "改好了没有，可以再试一次。"
        : "没能确认保存好了没有，可以再试一次。";
      return { kind: "unsure", text };
    }
    const fallback = what === "rename" ? "没能改名。" : what === "toggle" ? (on ? "没能启用。" : "没能停用。") : what === "cat" ? "没能改好" + cat + "，稍后再试。" : "没能保存。";
    return { kind: "form", text: sentence(err) || fallback };
  }
  // A lost answer to 停用 / 启用, after the list read again shows it was not done: what failed, briefly.
  const toggleFailed = (on, err) => failed(on ? "没能启用" : "没能停用", err);
  function removeError(err) {
    if (err && err.status === 404) return { kind: "gone", text: "" };
    if (unsure(err)) return { kind: "unsure", text: "没能确认移除了没有。它还在列表里，可以再试一次。" };
    return { kind: "form", text: sentence(err) || "没能移除，稍后再试。" };
  }
  const listError = (err) => failed("没能读到应用", err);
  // The checks made on opening, said once when the last one settles (to a screen reader). One turned off meanwhile
  // was not checked and is not counted.
  function checked(list) {
    const apps = (list || []).filter((a) => a && a.state !== "off");
    const n = (s) => apps.filter((a) => a && a.state === s).length;
    const on = n("on"), bad = n("failed"), rest = apps.length - on - bad;
    if (!apps.length) return "";
    if (apps.length === 1) return "「" + trim(apps[0].title) + "」" + (on ? "已连接。" : bad ? "没有回应。" : "没能检查。");
    const parts = [on ? on + " 个已连接" : "", bad ? bad + " 个没有回应" : "", rest ? rest + " 个没能检查" : ""].filter(Boolean);
    return "检查好了：" + parts.join("，") + "。";
  }

  root.ClowderAppsRules = Object.freeze({
    trim, WECHAT, path, UNREAD, unread, look, wechatActions, BUSY, POLL_EVERY, POLL_FOR, pollNext, deadline, clock, clockSaid, tickIn,
    WECHAT_LEAD, BY_NAME, BY_NAME_ON, OPEN_CHAT, OPEN_OFF, OPEN_LEFT, OPEN_UNKNOWN, authKnown, MORE, WECHAT_NOTES, sourceLabel, SOURCE_NOTE, sourceNote, WECHAT_SLOW, WECHAT_STILL, SAID,
    NAME_MAX, PROGRAM_MAX, ARGS_MAX, ARG_MAX, URL_MAX, SECRETS_MAX, VALUE_MAX, SECRETS_WORD, URL_SAID, EMPTY_SECRET,
    nameProblem, programProblem, argsOf, argsProblem, urlProblem, secretNameProblem, secretValueProblem, secretsOf, check, fingerprint, sameSource,
    sourceChange, catsOf, toggleLabel,
    splitCommand, commandLine, slowFirstRun, CUSTOM_LEAD, ADD_SCOPE, SECRETS_KEPT, added, SLOW_HINT, REMOVE_NOTE, removeTitle,
    sentence, ADD_UNSURE, addError, wechatError, checkError, patchError, toggleFailed, removeError, listError, checked,
  });
})(typeof window !== "undefined" ? window : globalThis);
