import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import express from 'express';
import { ZodError } from 'zod';
import { Doc, El, TextNode } from './fake-dom.js';
import { createApp } from '../server/app.js';
import { createXbotAppsRouter } from '../server/xbot/apps.js';
import { BotApps, parseCustomApp } from '../server/native/apps.js';
import { NativeFixture } from './native-fixture.js';
import { WECHAT_DISCLOSURE } from './apps-fixture.js';

// 应用 (apps-dialog-rules.js, apps-dialog.js; docs/xbot-frontend.md item 54):
// the dialog the sidebar's 应用 opens — 微信 and the owner's custom apps over
// /xbot-api/apps (docs/apps-api.md). The page scripts run here as the classic
// browser scripts they are, in a VM over the small DOM of tests/fake-dom.ts,
// with timers that run only when told to and a scripted /xbot-api/apps whose
// answers can be held, failed or cut. app.js is not loaded: its hooks are faked
// the way it passes them to init(), and static checks cover its wiring.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const settle = async (turns = 12) => { for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve)); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// ---------------------------------------------------------------- the page in a VM
// The small DOM lets anything take focus; a browser does not. Here, as in a browser, focus is refused by
// what is hidden, inert or disabled, and by anything that is neither a control nor given a tabindex
// (review r1, finding 7: a waiting place that cannot hold focus is no waiting place).
const browserFocusable = (n: El) => {
  for (let x: El | null = n; x; x = x.parent) if (x.hidden || x.inert) return false;
  if (n.disabled) return false;
  return n.hasAttribute('tabindex') || ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(n.tagName);
};
{
  const focus = El.prototype.focus;
  El.prototype.focus = function (this: El) { if (browserFocusable(this)) focus.call(this); };
}
// Where focus is now, as a browser would report it: something hidden, disabled or detached has lost it.
const focusIsUsable = (doc: Doc) => { const a = doc.activeElement as El; return a !== doc.body && a.isConnected && browserFocusable(a); };
function load() {
  const doc = new Doc();
  const window: Any = { crypto: webcrypto, matchMedia: () => ({ matches: false }) };
  let clock = 1_700_000_000_000, next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const context = vm.createContext({
    window, document: doc, console, URL, AbortController,
    setTimeout: (fn: () => void, ms = 0) => { const id = ++next; timers.set(id, { at: clock + ms, fn }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
  });
  vm.runInContext(read('client/public/apps-dialog-rules.js'), context);
  vm.runInContext(read('client/public/apps-dialog.js'), context);
  // Runs every timer due within ms, in order, with the promises they start.
  const advance = async (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      clock = Math.max(clock, due[1].at);
      timers.delete(due[0]);
      due[1].fn();
      await settle();
    }
    clock = end;
    await settle();
  };
  return { doc, window, timers, advance, now: () => clock, setNow: (t: number) => { clock = t; } };
}
const R = load().window.ClowderAppsRules;

// A scripted /xbot-api/apps: answers as the adapter does (docs/apps-api.md); calls can be held or failed.
const fail = (status: number | undefined, message = 'request failed', code?: string) => Object.assign(new Error(message), status ? { status } : {}, code ? { code } : {});
type Call = { method: string; path: string; body: Any; signal: Any };
function server(page: ReturnType<typeof load>) {
  const S: Any = {
    calls: [] as Call[],
    wechat: { id: 'wechat', kind: 'wechat', title: '微信', state: 'off', disclosure: WECHAT_DISCLOSURE, version: '0.1.0-alpha.7' },
    custom: [] as Any[],
    // method + ' ' + path → (call) => answer | Promise (throw to fail). Checked before the defaults.
    on: new Map<string, (c: Call) => Any>(),
    starts: 0, // reads that a started 微信 stays starting
    deaf: false, // true: an aborted request still answers later (a late success after the page gave up on it)
  };
  const app = (c: Any) => {
    const { checked, ...row } = c;
    return { ...row, ...(checked || { state: 'unchecked' }) };
  };
  S.add = (id: string, title: string, source: Any, checked: Any = { state: 'on', tools: [{ name: 'app_probe', description: 'Returns a fixed marker.' }] }) => {
    S.custom.push({ id, kind: 'custom', title, source, checked });
  };
  // The list as the adapter would answer it now (a copy: what was true when the request was answered).
  S.listNow = () => plain({ apps: [S.wechat, ...S.custom.map((x: Any) => ({ id: x.id, kind: 'custom', title: x.title, source: x.source, state: x.checked && x.checked.state === 'off' ? 'off' : 'unchecked', ...(x.checked && x.checked.state === 'off' ? { reason: '已停用' } : {}) }))] });
  function answer(c: Call): Any {
    const hook = S.on.get(c.method + ' ' + c.path);
    return hook ? hook(c) : S.fallback(c);
  }
  // The default answer, for a hook that wants to hold or wrap it.
  S.fallback = (c: Call): Any => {
    const base = '/xbot-api/apps';
    if (c.method === 'GET' && c.path === base) return S.listNow();
    const id = decodeURIComponent(c.path.slice(base.length + 1).split('/')[0]!);
    if (id === 'wechat') {
      const act = c.path.split('/').pop();
      if (c.method === 'GET') {
        if (S.wechat.state === 'starting' && --S.starts < 0) S.wechat = { ...S.wechat, state: 'on', authorization: { active: false, remaining_ms: 0 } };
        return S.wechat;
      }
      if (act === 'connect') S.wechat = S.starts > 0 ? { ...S.wechat, state: 'starting', reason: undefined } : { ...S.wechat, state: 'on', reason: undefined, authorization: { active: false, remaining_ms: 0 } };
      else if (act === 'disconnect') S.wechat = { ...S.wechat, state: 'off', authorization: undefined };
      else if (act === 'authorize') {
        if (S.wechat.state !== 'on') throw fail(409, '先打开微信这个应用', 'app_not_on');
        S.wechat = { ...S.wechat, authorization: { active: true, remaining_ms: 600_000, until: new Date(page.now() + 600_000).toISOString() } };
      } else if (act === 'revoke') S.wechat = { ...S.wechat, authorization: { active: false, remaining_ms: 0 } };
      return S.wechat;
    }
    if (c.method === 'POST' && c.path === base + '/custom') {
      const id2 = 'custom:' + String(c.body.name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const source = c.body.url ? { type: 'url', url: c.body.url, secrets: Object.keys(c.body.secrets || {}) } : { type: 'program', program: c.body.program, args: c.body.args, secrets: Object.keys(c.body.secrets || {}) };
      const failed = /missing/.test(c.body.program || '');
      S.add(id2, c.body.name, source, failed ? { state: 'failed', reason: `这台电脑上找不到「${c.body.program}」`, detail: `spawn ${c.body.program} ENOENT` } : undefined);
      return app(S.custom.at(-1));
    }
    const row = S.custom.find((x: Any) => x.id === id);
    if (!row) throw fail(404, '没有这个应用');
    if (c.method === 'GET') return app(row);
    if (c.method === 'PATCH') {
      if (c.body.name) row.title = c.body.name;
      if (c.body.secrets) row.source = { ...row.source, secrets: [...new Set([...row.source.secrets, ...Object.keys(c.body.secrets)])] };
      return app(row);
    }
    if (c.method === 'DELETE') { S.custom = S.custom.filter((x: Any) => x !== row); return { removed: true }; }
    throw fail(404, 'no route');
  }
  S.api = (path: string, opt: Any = {}) => {
    const c: Call = { method: opt.method || 'GET', path, body: opt.body ? plain(opt.body) : undefined, signal: opt.signal };
    S.calls.push(c);
    return new Promise((resolve, reject) => {
      if (c.signal && !S.deaf) c.signal.addEventListener('abort', () => reject(fail(undefined, '连不上 clowder-bot')));
      Promise.resolve().then(() => answer(c)).then((v) => resolve(v === undefined ? {} : plain(v)), reject);
    });
  };
  S.sent = (method: string, pattern: RegExp) => S.calls.filter((c: Call) => c.method === method && pattern.test(c.path));
  return S;
}
// A call that waits until released (or rejected), as a slow engine does.
function hold() {
  let release!: (v?: Any) => void, reject!: (e: Any) => void;
  const promise = new Promise((a, b) => { release = a; reject = b; });
  return { promise, release, reject };
}

const icon = (doc: Doc) => (name: string, extra?: string) => { const s = doc.createElementNS('svg', 'svg'); s.className = 'icon' + (extra ? ' ' + extra : ''); s.dataset.icon = name; return s; };
// What is on screen: hidden parts and what is there for a screen reader only are left out.
function seen(n: El | TextNode | null): string {
  if (!n) return '';
  if (n instanceof TextNode) return n.data;
  if (n.hidden || n.classList.contains('visually-hidden')) return '';
  return n.kids.map((k) => seen(k as Any)).join('');
}
const shown = (n: El) => { for (let x: El | null = n; x; x = x.parent) if (x.hidden) return false; return true; };
const all = (root: El, sel: string) => root.querySelectorAll(sel).filter(shown);
const one = (root: El, sel: string) => { const n = all(root, sel)[0]; assert.ok(n, 'nothing shown for ' + sel); return n!; };
const buttonOf = (root: El, label: string) => { const b = all(root, 'button').find((n) => seen(n).trim() === label); assert.ok(b, 'no button ' + label); return b!; };
const noButton = (root: El, label: string) => assert.ok(!all(root, 'button').some((n) => seen(n).trim() === label), 'a button ' + label + ' is shown');

async function opened(setup?: (s: Any, page: ReturnType<typeof load>) => void) {
  const page = load(), srv = server(page);
  if (setup) setup(srv, page);
  const opener = page.doc.createElement('button');
  opener.id = 'side-apps';
  const shell = page.doc.createElement('div');
  shell.id = 'shell';
  page.doc.body.append(shell, opener);
  page.window.ClowderApps.init({ api: srv.api, icon: icon(page.doc), now: page.now });
  opener.focus();
  page.window.ClowderApps.open({ opener });
  await settle();
  const card = () => page.doc.querySelector('.ap-card') as El;
  const body = () => page.doc.querySelector('.ap-body') as El;
  const row = (id: string) => page.doc.querySelector(`.ap-row[data-app="${id}"]`) as El;
  return { page, srv, opener, shell, card, body, row, title: () => seen(page.doc.querySelector('.ap-title')), voice: () => (page.doc.querySelector('.ap-card [role="status"]') as El).textContent };
}

// ---------------------------------------------------------------- rules
test('what each state is called and drawn as: a mark and a word, never colour alone; 微信 and custom apps from the contract', () => {
  const w = (s: Any) => plain(R.look({ kind: 'wechat', ...s }));
  assert.deepEqual(w({ state: 'off' }), { mark: 'idle', word: '未打开' });
  assert.deepEqual(w({ state: 'off', reason: '上次没能启动' }), { mark: 'bad', word: '上次没能启动' });
  assert.deepEqual(w({ state: 'starting' }), { mark: 'busy', word: '正在启动…' });
  assert.deepEqual(w({ state: 'on', authorization: { active: false } }), { mark: 'on', word: '已打开' });
  // The ten minutes cover only the chat open in 微信: on is 已打开 with or without them (round 2, docs/apps-api.md 「两种读法」).
  assert.deepEqual(w({ state: 'on', authorization: { active: true } }), { mark: 'on', word: '已打开' });
  assert.deepEqual(w({ state: 'on' }), { mark: 'on', word: '已打开' }, 'its ten minutes unknown: still simply on');
  assert.deepEqual([R.authKnown({ state: 'on' }), R.authKnown({ state: 'on', authorization: { active: false, remaining_ms: 0 } }), R.authKnown({ state: 'off', authorization: { active: false } })], [false, true, false]);
  assert.deepEqual(w({ state: 'failed', reason: '没能启动' }), { mark: 'bad', word: '没能启动' });
  assert.deepEqual(w({ state: 'unavailable', reason: '只在 Mac 上能用' }), { mark: 'off', word: '只在 Mac 上能用' });
  const c = (s: Any, check = '') => plain(R.look({ kind: 'custom', ...s }, check));
  assert.deepEqual(c({ state: 'unchecked' }), { mark: 'idle', word: '未检查' });
  assert.deepEqual(c({ state: 'unchecked' }, 'running'), { mark: 'busy', word: '正在检查…' });
  assert.deepEqual(c({ state: 'on' }), { mark: 'on', word: '已连接' });
  assert.deepEqual(c({ state: 'failed', reason: '几秒内没有回应' }), { mark: 'bad', word: '几秒内没有回应' });
  assert.deepEqual(c({ state: 'unchecked', reason: '没能检查' }), { mark: 'idle', word: '没能检查' });
  assert.deepEqual(c({ state: 'off', reason: '已停用' }), { mark: 'off', word: '已停用' });
  // The marks are five shapes in the stylesheet, each with its own drawing.
  const css = read('client/public/apps-dialog.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.ap-mark\.on::before \{ background: var\(--x-online\); \}/);
  assert.match(css, /\.ap-mark\.bad::before \{ border: 1\.6px solid var\(--x-danger\); \}/);
  assert.match(css, /\.ap-mark\.idle::before \{ height: 2px; border-radius: 1px; background: var\(--x-faint\); \}/);
  assert.match(css, /\.ap-mark\.off::after \{[^}]*transform: rotate\(45deg\)/);
  assert.match(css, /\.ap-mark\.busy > \.st-spin \{/);
  assert.match(css, /\.ap-mark \{[^}]*width: 11px; height: 11px; \}/, 'one slot for every mark: the word does not move when the state changes');
});

test('微信 offers only what can be done: open, close, try again; nothing while starting or unavailable; a manual re-read once the poll stops', () => {
  const acts = (s: Any, gave = false) => [...R.wechatActions({ kind: 'wechat', ...s }, gave)].map((a: Any) => a.label + (a.main ? '*' : ''));
  assert.deepEqual(acts({ state: 'off' }), ['打开*']);
  assert.deepEqual(acts({ state: 'off', reason: '上次没能启动' }), ['再试一次*']);
  assert.deepEqual(acts({ state: 'starting' }), []);
  assert.deepEqual(acts({ state: 'starting' }, true), ['再看一次']);
  assert.deepEqual(acts({ state: 'on' }), ['关闭']);
  assert.deepEqual(acts({ state: 'failed', reason: '没能启动' }), ['关闭', '再试一次*']);
  // Every one of them sits at the top, by the state (round 5: the consent wall before 打开 is gone; see the words test).
  for (const s of [{ state: 'off' }, { state: 'failed' }, { state: 'on' }, { state: 'starting' }]) for (const a of R.wechatActions({ kind: 'wechat', ...s }, true)) assert.equal('where' in a, false);
  assert.deepEqual(acts({ state: 'unavailable', reason: '只在 Mac 上能用' }), []);
  // A screen reader hears whose 打开 and 关闭 they are (the dialog's own × is 关闭 too); the shown word is in the name.
  for (const a of [...R.wechatActions({ state: 'failed' }), ...R.wechatActions({ state: 'off' })]) assert.ok(a.said.includes(a.label) && a.said !== a.label, a.said);
});

test('the starting poll: every 2 s, stops after about 2 minutes; the countdown runs from the server\'s until (or its remaining time, when this clock disagrees)', () => {
  assert.equal(R.POLL_EVERY, 2000);
  assert.equal(R.pollNext(0, 0), 2000);
  assert.equal(R.pollNext(0, 117_999), 2000);
  assert.equal(R.pollNext(0, 118_001), -1);
  const at = 1_700_000_000_000;
  assert.equal(R.deadline({ active: true, remaining_ms: 600_000, until: new Date(at + 600_000).toISOString() }, at), at + 600_000);
  assert.equal(R.deadline({ active: true, remaining_ms: 599_000, until: new Date(at + 600_000).toISOString() }, at), at + 600_000, 'a second apart: until');
  assert.equal(R.deadline({ active: true, remaining_ms: 300_000, until: new Date(at + 900_000).toISOString() }, at), at + 300_000, 'this clock is off by minutes: the remaining time from the read');
  assert.equal(R.deadline({ active: true, remaining_ms: 120_000 }, at), at + 120_000);
  assert.equal(R.deadline({ active: false, remaining_ms: 0 }, at), null);
  assert.equal(R.deadline(null, at), null);
  assert.deepEqual([R.clock(600_000), R.clock(599_001), R.clock(61_000), R.clock(999), R.clock(0), R.clock(-5)], ['10:00', '10:00', '1:01', '0:01', '0:00', '0:00']);
  assert.deepEqual([R.clockSaid(581_000), R.clockSaid(60_000), R.clockSaid(4_000)], ['还剩 9 分 41 秒', '还剩 1 分', '还剩 4 秒']);
  assert.deepEqual([R.tickIn(600_000), R.tickIn(599_400), R.tickIn(1), R.tickIn(0)], [1000, 400, 1, 0]);
});

test('the custom-app form checks what the adapter checks: whatever passes here passes the server, and its limits are the server\'s', () => {
  const base = { name: '我的笔记', kind: 'program', program: 'npx', args: '-y\nnotes-mcp@1.2.3', url: '', secrets: { program: [{ name: 'NOTES_TOKEN', value: 'abc' }], url: [] } };
  const ok = R.check(base);
  assert.deepEqual(plain(ok), { body: { name: '我的笔记', program: 'npx', args: ['-y', 'notes-mcp@1.2.3'], secrets: { NOTES_TOKEN: 'abc' } }, problems: [] });
  assert.doesNotThrow(() => parseCustomApp(ok.body));
  const url = R.check({ ...base, kind: 'url', url: ' https://mcp.linear.app/mcp ', secrets: { program: [], url: [{ name: 'Authorization', value: 'Bearer x' }] } });
  assert.deepEqual(plain(url.body), { name: '我的笔记', url: 'https://mcp.linear.app/mcp', secrets: { Authorization: 'Bearer x' } });
  assert.doesNotThrow(() => parseCustomApp(url.body));
  // Each refusal here is one the server makes too.
  const cases: Array<[Any, string]> = [
    [{ name: '  ' }, 'name'], [{ name: 'x'.repeat(41) }, 'name'], [{ program: '' }, 'program'], [{ program: 'p'.repeat(513) }, 'program'],
    [{ args: Array.from({ length: 33 }, (_, i) => 'a' + i).join('\n') }, 'args'], [{ args: 'x'.repeat(2049) }, 'args'],
    [{ kind: 'url', url: 'http://example.com/mcp' }, 'url'], [{ kind: 'url', url: 'https://u:p@example.com/' }, 'url'], [{ kind: 'url', url: 'ftp://x' }, 'url'], [{ kind: 'url', url: 'not a url' }, 'url'],
    [{ secrets: { program: [{ name: '1BAD', value: 'v' }], url: [] } }, 'secret-name'], [{ secrets: { program: [{ name: 'A B', value: 'v' }], url: [] } }, 'secret-name'],
    [{ kind: 'url', url: 'https://x.dev/', secrets: { program: [], url: [{ name: 'Bad Header', value: 'v' }] } }, 'secret-name'],
    [{ secrets: { program: [{ name: 'OK', value: '' }], url: [] } }, 'secret-value'], [{ secrets: { program: [{ name: 'OK', value: '••••••' }], url: [] } }, 'secret-value'],
  ];
  for (const [change, field] of cases) {
    const form = { ...base, ...change };
    const r = R.check(form);
    assert.ok(r.problems.some((p: Any) => p.field === field), JSON.stringify(change) + ' is refused here at ' + field);
    // The same content, as it would reach the server without the client's check, is refused there too.
    const raw = form.kind === 'url' ? { name: form.name, url: form.url, secrets: Object.fromEntries((form.secrets.url || []).map((s: Any) => [s.name, s.value])) }
      : { name: form.name, program: form.program, args: String(form.args).split('\n'), secrets: Object.fromEntries((form.secrets.program || []).map((s: Any) => [s.name, s.value])) };
    assert.throws(() => parseCustomApp(raw), (e: unknown) => e instanceof ZodError || (e as Any).status === 400, JSON.stringify(change) + ' is refused by the server');
  }
  // Local addresses may be http://.
  for (const u of ['http://localhost:3000/mcp', 'http://127.0.0.1:9/mcp', 'http://[::1]:8080/']) { assert.equal(R.urlProblem(u), ''); assert.doesNotThrow(() => parseCustomApp({ name: 'x', url: u })); }
  assert.equal(R.urlProblem('http://example.com/'), R.URL_SAID, 'the server\'s own sentence');
  // Rows left empty are no secret; a name twice is one problem (a header's case does not matter); arguments are lines, blank ones dropped.
  assert.deepEqual(plain(R.secretsOf([{ name: '', value: '' }, { name: 'A', value: '1' }], 'program')), { secrets: { A: '1' }, problems: [] });
  assert.equal(R.secretsOf([{ name: 'A', value: '1' }, { name: 'A', value: '2' }], 'program').problems[0].text, '名称重复了');
  assert.equal(R.secretsOf([{ name: 'X-Key', value: '1' }, { name: 'x-key', value: '2' }], 'url').problems.length, 1);
  assert.deepEqual(plain(R.argsOf('  -y \n\n notes  \n')), ['-y', 'notes']);
  // One secret cannot be emptied (the engine has no such operation): said only when someone tries.
  assert.equal(R.secretValueProblem('', true), R.EMPTY_SECRET);
  assert.match(R.EMPTY_SECRET, /移除这个应用再重新添加/);
  // The fingerprint does not depend on key order (the same content is the same request).
  assert.equal(R.fingerprint({ a: 1, b: [1, { c: 2, d: 3 }] }), R.fingerprint({ b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.notEqual(R.fingerprint({ a: 1 }), R.fingerprint({ a: 2 }));
});

test('a pasted command line is split only when a shell would split it the same way and nothing else could be meant', () => {
  const s = (t: string) => plain(R.splitCommand(t));
  assert.deepEqual(s('npx -y @modelcontextprotocol/server-filesystem /Users/me/Documents'), ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/Users/me/Documents']);
  assert.deepEqual(s('uvx mcp-server-git --repository "/Users/me/My Repo"'), ['uvx', 'mcp-server-git', '--repository', '/Users/me/My Repo']);
  assert.deepEqual(s("node 'server one.js' --flag=a\\ b"), ['node', 'server one.js', '--flag=a b']);
  assert.deepEqual(s('npx -y \\\n  some-mcp'), ['npx', '-y', 'some-mcp'], 'a line continued with a backslash');
  for (const t of ['npx', '  npx  ', 'cat a | grep b', 'run && go', 'echo $(whoami)', 'echo `id`', 'TOKEN=abc npx thing', 'npx "unclosed', 'run > out.txt', '/Applications/My App/bin/server', '~/My Tools/run', 'echo "$HOME"'])
    assert.equal(R.splitCommand(t), null, t);
  assert.deepEqual(s('/Applications/My App/bin/server --stdio'), ['/Applications/My', 'App/bin/server', '--stdio'], 'a path with options is split as a shell would');
  // The page's one line for a program round-trips through the same split.
  for (const words of [['npx', '-y', 'a b'], ['node', "it's", '--x=$y'], ['uvx', '', 'c'], ['run', 'a|b', '(x)']]) {
    const line = R.commandLine(words[0], words.slice(1));
    assert.deepEqual(plain(R.splitCommand(line)), words, line);
  }
  assert.equal(R.commandLine('npx', ['-y', 'notes-mcp@1.2.3']), 'npx -y notes-mcp@1.2.3');
  assert.equal(R.commandLine('node', ['my server.js']), "node 'my server.js'");
});

test('failed requests say what failed: the server\'s 4xx sentence as it said it (without a field path), a short reason otherwise; lost answers are told apart', () => {
  assert.equal(R.sentence(fail(400, 'url: 网址需要以 https:// 开头（本机地址可以用 http://），且不带用户名密码')), '网址需要以 https:// 开头（本机地址可以用 http://），且不带用户名密码。');
  assert.equal(R.sentence(fail(400, '「a b」不能用作变量的名称')), '「a b」不能用作变量的名称。');
  assert.equal(R.sentence(fail(400, 'name: Too big: expected string to have <=40 characters')), '', 'not everyday words: not shown');
  assert.equal(R.sentence(fail(409, '原生会话出错')), '', 'the engine\'s words are not shown');
  assert.deepEqual(plain(R.addError(fail(undefined, '连不上 clowder-bot'))), { kind: 'unsure', text: R.ADD_UNSURE });
  assert.equal(R.addError(fail(502, '没能添加，请再试一次')).kind, 'unsure', 'a 5xx may have added it');
  assert.deepEqual(plain(R.addError(fail(400, '请填要运行的程序，或者一个网址（二选一）'))), { kind: 'form', text: '请填要运行的程序，或者一个网址（二选一）' }, 'a sentence that already ends is left as it is');
  assert.match(R.ADD_UNSURE, /不会多加一个/);
  assert.deepEqual(plain(R.wechatError(fail(409, '先打开微信这个应用', 'app_not_on'), 'authorize')), { kind: 'reread', text: '先打开微信这个应用。' });
  assert.equal(R.wechatError(fail(409, '只在 Mac 上能用', 'app_unavailable'), 'connect').kind, 'reread');
  assert.deepEqual(plain(R.wechatError(fail(503, '服务出了点问题，请稍后再试。'), 'connect')), { kind: 'unsure', text: '没能打开微信：服务出了点问题，稍后再试。' });
  assert.deepEqual(plain(R.wechatError(fail(undefined), 'authorize')), { kind: 'unsure', text: '没能授权：连不上 clowder-bot，稍后再试。' });
  assert.equal(R.checkError(fail(404)).kind, 'gone');
  assert.equal(R.checkError(fail(500)).text, '没能检查：服务出了点问题，稍后再试。');
  assert.equal(R.patchError(fail(404), 'rename').kind, 'gone');
  assert.equal(R.patchError(fail(undefined), 'secret').kind, 'unsure');
  assert.equal(R.removeError(fail(404)).kind, 'gone');
  assert.equal(R.removeError(fail(503)).kind, 'unsure');
  assert.equal(R.listError(fail(undefined)), '没能读到应用：连不上 clowder-bot，稍后再试。');
  assert.equal(R.checked([{ title: 'A', state: 'on' }, { title: 'B', state: 'failed' }, { title: 'C', state: 'on' }]), '检查好了：2 个已连接，1 个没有回应。');
  assert.equal(R.checked([{ title: '我的笔记', state: 'on' }]), '「我的笔记」已连接。');
  assert.equal(R.checked([]), '');
});

test('the words (round 5, the owner: 「这个界面的文字显然过于冗杂了」): in front of a button only what a person would be misled without; the rest of what is true behind 说明; none of the false sentences', () => {
  // docs/apps-api.md 「界面怎么说」. Before 打开: one sentence — opening is what lets cats read by name, until it is closed.
  assert.equal(R.WECHAT_LEAD, '打开后，猫猫可以按联系人的名字读这台 Mac 上的微信，直到你关闭。');
  assert.doesNotMatch(R.WECHAT_LEAD, /10 分钟|授权|截图|Agent|模型|前面|权限|屏幕录制/, 'nothing about the ten minutes, screenshots, where the text goes, the window or permissions');
  // Once open the rows say it: two titles, their states (a mark and a word), no sentences.
  assert.deepEqual([R.BY_NAME, R.BY_NAME_ON, R.OPEN_CHAT, R.OPEN_OFF, R.OPEN_LEFT, R.OPEN_UNKNOWN], ['按名字读联系人', '可用', '读微信里正打开的那段聊天', '未授权', '授权还剩', '没能读到授权状态']);
  // Behind 说明, each fact that left the surface, briefly.
  assert.equal(R.MORE, '说明');
  const more = R.WECHAT_NOTES.join('');
  for (const fact of [
    '只读', '不发消息', '不点链接', '聊天记录库', '截图认字', '截图不保存', // how it reads
    '和你发给猫猫的话一样', '交给它用的 Agent 和模型', '执行记录', // where the text goes: both recipients
    '按名字读时', '短暂切到前面', '标为已读', '复原', // what reading by name does to 微信
    '系统设置 › 隐私与安全性', '「屏幕录制」', '按名字读还要「辅助功能」', '猫猫会说没能读到', '启动 clowder-bot 的程序', // the permissions
    '「Plugin Hub」', // what a refused cat's words point at
  ]) assert.ok(more.includes(fact), fact);
  // The sentence the vocabulary rule excepts moved here unchanged (tests/vocabulary.test.ts, CONSENT).
  assert.equal(R.WECHAT_NOTES[1], '认出的文字会和你发给猫猫的话一样，交给它用的 Agent 和模型，并留在那段聊天的执行记录里。');
  assert.doesNotMatch(more, /会请你|会弹|会问|Terminal|终端|iTerm|Cat Café/, 'no system prompt promised, no program named');
  // The plugin's own words, labelled as its own, with our correction where they say 逐次授权.
  assert.equal(R.sourceLabel('0.1.0-alpha.7'), '插件原文 · 0.1.0-alpha.7');
  assert.equal(R.sourceLabel(''), '插件原文');
  assert.equal(R.sourceNote(WECHAT_DISCLOSURE), R.SOURCE_NOTE);
  assert.equal(R.sourceNote('不会保存截图。'), '', 'only where it is needed');
  for (const fact of ['逐次授权', '不会每次问你', '猫猫自己确认']) assert.ok(R.SOURCE_NOTE.includes(fact), fact);
  // The ten minutes ending is said as the ten minutes ending, not as all reading ending.
  assert.equal(R.SAID.ended, '微信的 10 分钟授权结束了，按名字读不受影响。');
  // The false sentences (and the old constants of the wall) are gone from both scripts.
  for (const file of ['client/public/apps-dialog-rules.js', 'client/public/apps-dialog.js']) {
    const src = read(file).replace(/\/\/[^\n]*/g, '');
    for (const wrong of [/猫猫现在还不能读/, /每次都会先问你/, /猫猫现在可以读微信/, /"可以读"/, /macOS 会请你允许/, /第一次读的时候/, /读取授权已经结束/, /WECHAT_FACTS|WECHAT_NOT_YET|WECHAT_CAN|WECHAT_HOW|WECHAT_FIRST/,
      /BY_NAME_REACH|OPEN_LATER|OPEN_ASK|OPEN_SAY|WECHAT_SAY|WECHAT_READS|WECHAT_PERMISSIONS|WECHAT_HUB|WECHAT_ABOUT|consequences/])
      assert.doesNotMatch(src, wrong, file + ': ' + wrong);
  }
  // 添加: one line in front of it (every cat, unasked), how secrets are kept next to them; nothing else.
  assert.equal(R.ADD_SCOPE, '所有猫猫都能用它，用的时候不会先问你。');
  assert.equal(R.SECRETS_KEPT, '值会原样存在这台电脑上，不加密。');
  assert.equal(R.CUSTOM_LEAD, '接入一个 MCP 服务。');
  for (const file of ['client/public/apps-dialog-rules.js', 'client/public/apps-dialog.js']) assert.doesNotMatch(read(file), /以你的身份运行/, 'the type, 本机程序, says where it runs');
  // MCP appears in one string of either script: the add form's line (without it 网址 reads as "add a website").
  for (const file of ['client/public/apps-dialog-rules.js', 'client/public/apps-dialog.js']) {
    const strings = [...read(file).replace(/\/\/[^\n]*/g, '').matchAll(/"([^"\n]*)"/g)].map((m) => m[1]!).filter((s) => /MCP/.test(s));
    assert.deepEqual(strings, file.endsWith('rules.js') ? ['接入一个 MCP 服务。'] : [], file);
  }
  assert.equal(R.removeTitle(' 我的笔记 '), '移除「我的笔记」？');
  assert.equal(R.REMOVE_NOTE, '移除后不能恢复，猫猫从下一条消息起就用不了它。', 'the consequence of removing stays');
  // Added: on the page the state line says how it is, so the note says only that it is in; said to a screen
  // reader after the owner left the form, with its state.
  assert.deepEqual([R.added({ state: 'on' }), R.added({ state: 'failed' }), R.added({ state: 'unchecked' })], ['加好了。', '已经加上了。', '已经加上了。']);
  assert.deepEqual([R.added({ state: 'on' }, true), R.added({ state: 'failed' }, true), R.added({ state: 'unchecked' }, true)], ['加好了。', '已经加上了，但它没有回应。', '已经加上了，但没能检查它。']);
  assert.equal(R.SLOW_HINT, '第一次运行要先下载，稍后再试一次。');
  assert.equal(R.WECHAT_SLOW, '第一次可能要半分钟以上。');
  assert.equal(R.slowFirstRun({ state: 'failed', reason: '几秒内没有回应', source: { type: 'program', program: '/usr/local/bin/npx', args: [] } }), true);
  assert.equal(R.slowFirstRun({ state: 'failed', reason: '几秒内没有回应', source: { type: 'program', program: 'node', args: [] } }), false);
  assert.equal(R.slowFirstRun({ state: 'failed', reason: '连不上这个网址', source: { type: 'url', url: 'https://x' } }), false);
});

// ---------------------------------------------------------------- the dialog
test('应用 opens over the chat: a dialog with its title, the list read once, 微信 first, then the custom apps, then 添加自定义应用; nothing that is not there', async () => {
  const { page, srv, card, body, row, title } = await opened((s) => {
    s.add('custom:notes', '我的笔记', { type: 'program', program: 'npx', args: ['-y', 'notes'], secrets: ['NOTES_TOKEN'] });
    s.add('custom:off', '停用的', { type: 'program', program: 'x', args: [], secrets: [] }, { state: 'off', reason: '已停用' });
  });
  assert.equal(card().getAttribute('role'), 'dialog');
  assert.equal(card().getAttribute('aria-modal'), 'true');
  assert.equal(title(), '应用');
  assert.equal(srv.sent('GET', /^\/xbot-api\/apps$/).length, 1);
  const rows = all(body(), '.ap-row').map((r) => r.dataset.app || 'add');
  assert.deepEqual(rows, ['wechat', 'custom:notes', 'custom:off', 'add']);
  assert.equal(seen(row('wechat')), '微信未打开');
  assert.equal(seen(one(body(), '.ap-row-add')), '添加自定义应用');
  // No store, search, categories, counts or promises.
  const words = seen(body());
  for (const absent of ['搜索', '推荐', '已连接 ', '即将', '更多应用', '分类']) assert.ok(!words.includes(absent), absent);
  assert.equal(all(body(), 'input').length, 0);
  // Opening checked the one that can be checked (the turned-off one is not).
  assert.deepEqual(srv.calls.filter((c: Call) => c.method === 'GET').map((c: Call) => c.path), ['/xbot-api/apps', '/xbot-api/apps/custom%3Anotes']);
  assert.equal(seen(row('custom:notes')), '我的笔记已连接');
  assert.equal(seen(row('custom:off')), '停用的已停用');
  // Everything behind it is out of reach.
  assert.equal((page.doc.getElementById('shell') as El).inert, true);
});

test('with none of the owner\'s own, the list is 微信 and the add row — not an empty shelf; with twelve, each says its state at a glance', async () => {
  const empty = await opened();
  assert.deepEqual(all(empty.body(), '.ap-rows').map((g) => all(g, '.ap-row').length), [1, 1]);
  assert.equal(seen(empty.body()), '微信未打开添加自定义应用');
  const many = await opened((s) => { for (let i = 1; i <= 12; i++) s.add('custom:t' + i, 'Tool ' + i, { type: 'program', program: 'node', args: [], secrets: [] }, i % 4 === 0 ? { state: 'failed', reason: '几秒内没有回应' } : undefined); });
  await many.page.advance(0);
  assert.equal(all(many.body(), '.ap-row').length, 14);
  for (let i = 1; i <= 12; i++) assert.equal(seen(one(many.row('custom:t' + i), '.ap-st-word')), i % 4 === 0 ? '几秒内没有回应' : '已连接');
  assert.match(many.voice(), /^检查好了：9 个已连接，3 个没有回应。$/);
});

test('opening checks each custom app once, at most three at a time; rows settle one by one; closing abandons what is in flight; nothing is checked on a timer', async () => {
  const gates = new Map<string, ReturnType<typeof hold>>();
  const { page, srv, row, opener, voice } = await opened((s) => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      s.add('custom:' + id, id.toUpperCase(), { type: 'program', program: 'node', args: [], secrets: [] });
      const g = hold();
      gates.set(id, g);
      s.on.set('GET /xbot-api/apps/custom%3A' + id, () => g.promise.then(() => ({ id: 'custom:' + id, kind: 'custom', title: id.toUpperCase(), state: id === 'b' ? 'failed' : 'on', reason: id === 'b' ? '没连上' : undefined, tools: [], source: { type: 'program', program: 'node', args: [], secrets: [] } })));
    }
  });
  assert.equal(srv.sent('GET', /custom%3A/).length, 3, 'three at a time');
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map((id) => seen(one(row('custom:' + id), '.ap-st-word'))), ['正在检查…', '正在检查…', '正在检查…', '未检查', '未检查']);
  gates.get('b')!.release();
  await settle();
  assert.equal(seen(one(row('custom:b'), '.ap-st-word')), '没连上');
  assert.equal(srv.sent('GET', /custom%3A/).length, 4, 'the next one starts when one settles');
  assert.equal(seen(one(row('custom:d'), '.ap-st-word')), '正在检查…');
  assert.equal(voice(), '', 'nothing said until the last one settles');
  // Time passes: nothing is read again by itself.
  await page.advance(600_000);
  assert.equal(srv.calls.length, 5);
  // Closed: everything in flight is abandoned, focus is back on 应用, the page behind is reachable again.
  page.doc.querySelector('.ap-x')!.click();
  assert.ok(srv.calls.filter((c: Call) => /custom%3A/.test(c.path)).filter((c: Call) => c.path !== '/xbot-api/apps/custom%3Ab').every((c: Call) => c.signal.aborted), 'in flight: aborted');
  assert.equal(page.doc.querySelector('.ap-modal'), null);
  assert.equal(page.doc.activeElement, opener);
  assert.equal((page.doc.getElementById('shell') as El).inert, false);
  for (const g of gates.values()) g.release();
  await page.advance(600_000);
  assert.equal(srv.calls.length, 5, 'nothing after closing');
});

test('Escape goes up one level, then closes; focus returns to where it came from; Tab stays inside', async () => {
  const { page, srv, row, card, opener, title } = await opened((s) => s.add('custom:notes', '我的笔记', { type: 'program', program: 'npx', args: [], secrets: [] }));
  void srv;
  row('custom:notes').click();
  await settle();
  assert.equal(title(), '我的笔记');
  assert.equal(page.doc.activeElement, page.doc.querySelector('.ap-title'), 'a page starts at its title');
  // From the title, Tab moves on in reading order (the browser's own move; the trap only wraps at the two ends).
  assert.equal(page.doc.activeElement.key('Tab').defaultPrevented, false);
  const esc = page.doc.activeElement.key('Escape');
  assert.ok(esc.defaultPrevented);
  assert.equal(title(), '应用');
  assert.equal(page.doc.activeElement, row('custom:notes'), 'back to the row it came from');
  // A second document-level Escape listener (app.js's) never sees the key.
  let leaked = false;
  page.doc.addEventListener('keydown', () => { leaked = true; });
  row('custom:notes').key('Escape');
  assert.equal(leaked, false);
  assert.equal(page.doc.querySelector('.ap-modal'), null);
  assert.equal(page.doc.activeElement, opener);
  // Tab from the last control goes to the first, Shift+Tab from the first to the last.
  page.window.ClowderApps.open({ opener });
  await settle();
  const controls = card().querySelectorAll('button').filter(shown);
  controls.at(-1)!.focus();
  const ev = controls.at(-1)!.key('Tab');
  assert.ok(ev.defaultPrevented);
  assert.equal(page.doc.activeElement, controls[0]);
  controls[0]!.key('Tab', { shiftKey: true });
  assert.equal(page.doc.activeElement, controls.at(-1));
});

// The page's words in reading order, each block on its own line (hidden parts and screen-reader-only words left out).
// What a screen reader hears of an element: aria-hidden and hidden parts left out, visually-hidden ones kept.
const heard = (n: El | TextNode | null): string => {
  if (!n) return '';
  if (n instanceof TextNode) return n.data;
  if (n.hidden || n.getAttribute('aria-hidden') === 'true') return '';
  return n.kids.map((k) => heard(k as Any)).join('');
};
// What a screen reader hears describing a button.
const said = (doc: Doc, b: El) => (b.getAttribute('aria-describedby') || '').split(' ').filter(Boolean).map((id) => seen(doc.getElementById(id))).join('');
const lines = (root: El) => all(root, 'h3, p, button').filter((n) => seen(n).trim()).map((n) => seen(n).trim());

test('微信 off (round 5): one sentence and 打开 — the one fact a person would be misled without, and the button described by it; the rest behind 说明, the plugin\'s words there with our correction', async () => {
  const { page, srv, row, body } = await opened();
  row('wechat').click();
  await settle();
  assert.equal(seen(one(body(), '.ap-state')), '未打开');
  assert.deepEqual(lines(one(body(), '.ap-wechat')), ['未打开', R.WECHAT_LEAD, '打开', '说明'], 'one sentence and the button; nothing about the ten minutes, the window, the permissions');
  const open = buttonOf(body(), '打开');
  assert.equal(open.getAttribute('aria-label'), '打开微信');
  assert.equal(said(page.doc, open), R.WECHAT_LEAD, 'heard as it is seen before pressing: that sentence, no more');
  // 说明: one control, collapsed until asked for; every fact that left the surface is in it.
  const more = buttonOf(body(), '说明');
  const box = page.doc.getElementById(more.getAttribute('aria-controls')!) as El;
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  assert.equal(box.hidden, true);
  more.click();
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(lines(box), [...R.WECHAT_NOTES, '插件原文 · 0.1.0-alpha.7', WECHAT_DISCLOSURE, R.SOURCE_NOTE], 'the plugin\'s words verbatim under their own label, our correction after them');
  more.click();
  assert.equal(box.hidden, true);
  srv.on.set('POST /xbot-api/apps/wechat/connect', () => { srv.wechat = { ...srv.wechat, state: 'off', reason: '上次没能启动', detail: 'UNEXPECTED_RUNTIME_FAILURE · Plugin runtime reported UNEXPECTED_RUNTIME_FAILURE.' }; return srv.wechat; });
  open.click();
  assert.equal(seen(open), '正在打开…');
  assert.equal(open.disabled, true);
  await settle();
  assert.equal(seen(one(body(), '.ap-state')), '上次没能启动');
  assert.ok(one(body(), '.ap-state-word').classList.contains('bad'));
  // 再试一次 opens again: the same sentence before it, describing it.
  const retry = buttonOf(body(), '再试一次');
  assert.deepEqual(lines(one(body(), '.ap-wechat')), ['上次没能启动', R.WECHAT_LEAD, '详情', '再试一次', '说明']);
  assert.equal(said(page.doc, retry), R.WECHAT_LEAD);
  assert.equal(srv.sent('POST', /connect$/).length, 1);
  // The engine's words: there on request, never in the way.
  const detail = page.doc.querySelector('.ap-detail-text') as El;
  assert.equal(detail.hidden, true);
  buttonOf(body(), '详情').click();
  assert.equal(detail.hidden, false);
  assert.match(detail.textContent, /UNEXPECTED_RUNTIME_FAILURE/);
});

test('微信 starting is shown as starting (never on): read again every 2 s; after about 2 minutes it stops, still says starting, offers 再看一次 and says so once', async () => {
  const { page, srv, row, body, voice } = await opened((s) => { s.starts = 1000; });
  row('wechat').click();
  await settle();
  buttonOf(body(), '打开').click();
  await settle();
  assert.equal(seen(one(body(), '.ap-state')), '正在启动…');
  assert.ok(one(body(), '.ap-mark').classList.contains('busy'));
  assert.equal(all(body(), '.ap-hero-acts button').length, 0, 'nothing to press while it starts');
  assert.equal(all(body(), '.ap-way').length, 0, 'no rows before it is on');
  assert.equal(all(body(), '.ap-about').length, 0, 'nor the sentence that goes with 打开');
  assert.equal(seen(one(body(), '.ap-note')), R.WECHAT_SLOW);
  const reads = () => srv.sent('GET', /\/wechat$/).length;
  await page.advance(1999);
  assert.equal(reads(), 0);
  await page.advance(1);
  assert.equal(reads(), 1);
  await page.advance(10_000);
  assert.equal(reads(), 6);
  await page.advance(120_000);
  const total = reads();
  assert.ok(total >= 58 && total <= 60, 'about two minutes of reads: ' + total);
  await page.advance(600_000);
  assert.equal(reads(), total, 'then it stops');
  assert.equal(seen(one(body(), '.ap-state')), '正在启动…');
  assert.equal(seen(one(body(), '.ap-note')), R.WECHAT_STILL);
  assert.equal(voice(), R.SAID.still);
  // A manual re-read; still starting, the poll begins again; on → said once.
  srv.starts = 0;
  buttonOf(body(), '再看一次').click();
  await settle();
  assert.equal(seen(one(body(), '.ap-state')), '已打开');
  assert.equal(voice(), R.SAID.still, 'what the owner just asked for is not announced');
  // A start that finishes while the dialog polls is announced.
  const second = await opened((s) => { s.starts = 2; });
  second.row('wechat').click();
  await settle();
  buttonOf(second.body(), '打开').click();
  await settle();
  await second.page.advance(6000);
  assert.equal(seen(one(second.body(), '.ap-state')), '已打开');
  assert.equal(second.voice(), R.SAID.started);
  // Back on the list, the row says the same.
  second.page.doc.activeElement.key('Escape');
  assert.equal(seen(one(second.row('wechat'), '.ap-st-word')), '已打开');
});

test('微信 on (round 5): the two ways as two rows, each its own state and control — by name 可用 (a mark, nothing to press); the open chat 未授权 with 授权 10 分钟, then 授权还剩 m:ss with 撤销; one fresh read at zero', async () => {
  const { page, srv, row, body, voice } = await opened((s) => { s.wechat = { ...s.wechat, state: 'on', authorization: { active: false, remaining_ms: 0 } }; });
  assert.equal(seen(row('wechat')), '微信已打开', 'the row says it is open, nothing about who may read');
  row('wechat').click();
  await settle();
  assert.deepEqual(lines(one(body(), '.ap-wechat')), ['已打开', '关闭', R.BY_NAME, R.BY_NAME_ON, R.OPEN_CHAT, R.OPEN_OFF, '授权 10 分钟', '说明']);
  const byName = one(body(), '.ap-by-name');
  assert.ok(one(byName, '.ap-mark').classList.contains('on'), 'by name: a mark and a word');
  assert.equal(all(byName, 'button').length, 0, 'and nothing to press');
  assert.equal(buttonOf(body(), '关闭').getAttribute('aria-label'), '关闭微信');
  const authorize = buttonOf(body(), '授权 10 分钟');
  assert.equal(said(page.doc, authorize), R.OPEN_CHAT + R.OPEN_OFF, 'heard with its row, as it is seen');
  assert.ok(!authorize.dataset.tip && !authorize.getAttribute('title'));
  // Authorize: the countdown runs from the server's until, not from the click.
  srv.on.set('POST /xbot-api/apps/wechat/authorize', () => {
    srv.wechat = { ...srv.wechat, authorization: { active: true, remaining_ms: 595_000, until: new Date(page.now() + 595_000).toISOString() } };
    return srv.wechat;
  });
  authorize.focus();
  authorize.click();
  await settle();
  assert.deepEqual(lines(one(body(), '.ap-wechat')), ['已打开', '关闭', R.BY_NAME, R.BY_NAME_ON, R.OPEN_CHAT, R.OPEN_LEFT + ' 9:55', '撤销', '说明']);
  const st = one(body(), '.ap-open .ap-way-st');
  assert.equal(heard(st), '授权还剩 9 分 55 秒', 'a screen reader hears whose time it is');
  assert.equal(page.doc.activeElement, st, 'focus where the answer is');
  const revoke = buttonOf(body(), '撤销');
  assert.ok(one(body(), '.ap-open').contains(revoke), '撤销 sits in the open chat\'s row');
  assert.equal(said(page.doc, revoke), R.OPEN_CHAT + R.OPEN_LEFT + ' 9:55');
  await page.advance(5_000);
  assert.equal(seen(one(body(), '.ap-clock')), '9:50');
  assert.equal(srv.sent('GET', /\/wechat$/).length, 0, 'the clock is this page\'s, no reads while it runs');
  // The list row counts down too, as the authorization's time — never as whether cats can read.
  page.doc.activeElement.key('Escape');
  assert.equal(seen(row('wechat')), '微信已打开 · 授权还剩 9:50');
  row('wechat').click();
  await settle();
  // At zero, one fresh read; the plugin ended it: said once, as the ten minutes ending, not all reading.
  srv.on.set('GET /xbot-api/apps/wechat', () => ({ ...srv.wechat, authorization: { active: false, remaining_ms: 0 } }));
  await page.advance(590_000);
  assert.equal(srv.sent('GET', /\/wechat$/).length, 1);
  assert.equal(seen(one(body(), '.ap-open')), R.OPEN_CHAT + R.OPEN_OFF + '授权 10 分钟');
  assert.equal(seen(one(body(), '.ap-by-name')), R.BY_NAME + R.BY_NAME_ON, 'reading by name is still there');
  assert.equal(voice(), R.SAID.ended);
  await page.advance(600_000);
  assert.equal(srv.sent('GET', /\/wechat$/).length, 1, 'only one');
});

test('微信 on whose ten-minute status could not be read (no `authorization`): unknown — never "not authorized", no countdown; one fresh read on request; 撤销 still there; the row is plain 已打开', async () => {
  const { page, srv, row, body, voice } = await opened((s) => { s.wechat = { ...s.wechat, state: 'on', authorization: undefined }; });
  assert.equal(seen(row('wechat')), '微信已打开', 'the on wording, no time');
  row('wechat').click();
  await settle();
  assert.deepEqual(lines(one(body(), '.ap-wechat')), ['已打开', '关闭', R.BY_NAME, R.BY_NAME_ON, R.OPEN_CHAT, R.OPEN_UNKNOWN, '再看一次', '撤销', '说明'],
    'by name and 关闭 as when on; the open chat: unknown, with no 授权 offer and no clock');
  assert.equal(all(body(), '.ap-clock').length, 0);
  // A fresh read that fails says so where it was asked; one that answers shows what the plugin said.
  let n = 0;
  srv.on.set('GET /xbot-api/apps/wechat', () => {
    if (n++ === 0) throw fail(502);
    return { ...srv.wechat, authorization: { active: true, remaining_ms: 300_000, until: new Date(page.now() + 300_000).toISOString() } };
  });
  buttonOf(body(), '再看一次').focus();
  buttonOf(body(), '再看一次').click();
  await settle();
  assert.equal(seen(one(body(), '.ap-auth-note')), '没能读到微信现在的状态：服务出了点问题，稍后再试。');
  assert.equal(seen(page.doc.activeElement), '再看一次');
  assert.equal(seen(one(body(), '.ap-state')), '已打开', 'nothing else changed');
  buttonOf(body(), '再看一次').click();
  await settle();
  assert.equal(seen(one(body(), '.ap-clock')), '5:00');
  assert.equal(page.doc.activeElement, one(body(), '.ap-open .ap-way-st'));
  assert.equal(srv.sent('GET', /\/wechat$/).length, 2, 'only when asked');
  // At zero the one fresh read comes back unknown: not said to be over, and the unknown state returns.
  srv.on.set('GET /xbot-api/apps/wechat', () => ({ ...srv.wechat, authorization: undefined }));
  await page.advance(300_000);
  assert.equal(srv.sent('GET', /\/wechat$/).length, 3);
  assert.equal(seen(one(body(), '.ap-open')), R.OPEN_CHAT + R.OPEN_UNKNOWN + '再看一次撤销');
  assert.notEqual(voice(), R.SAID.ended);
  // 撤销 works either way; its answer carries the authorization again.
  srv.on.delete('GET /xbot-api/apps/wechat');
  const revoke = all(body(), '.ap-open button').find((b) => seen(b) === '撤销')!;
  assert.equal(said(page.doc, revoke), R.OPEN_CHAT + R.OPEN_UNKNOWN, 'heard with its row');
  revoke.focus();
  revoke.click();
  await settle();
  assert.equal(srv.sent('POST', /revoke$/).length, 1);
  assert.equal(seen(one(body(), '.ap-open')), R.OPEN_CHAT + R.OPEN_OFF + '授权 10 分钟');
  assert.equal(seen(page.doc.activeElement), R.OPEN_OFF, 'focus on the row\'s new state');
});

test('the countdown stops with the dialog; opening again reads the state fresh; 撤销 ends it at once', async () => {
  const { page, srv, row, body } = await opened((s) => { s.wechat = { ...s.wechat, state: 'on', authorization: { active: true, remaining_ms: 300_000, until: new Date(1_700_000_000_000 + 300_000).toISOString() } }; });
  assert.match(seen(row('wechat')), /已打开 · 授权还剩 5:00$/);
  row('wechat').click();
  await settle();
  buttonOf(body(), '撤销').focus();
  buttonOf(body(), '撤销').click();
  await settle();
  assert.equal(srv.sent('POST', /revoke$/).length, 1);
  // 撤销 ended the open chat only: its row says 未授权 (focus there), reading by name is untouched.
  assert.equal(seen(page.doc.activeElement), R.OPEN_OFF);
  assert.equal(seen(one(body(), '.ap-state')), '已打开');
  assert.equal(seen(one(body(), '.ap-by-name')), R.BY_NAME + R.BY_NAME_ON);
  // Closed while authorized: no timer is left.
  srv.wechat = { ...srv.wechat, authorization: { active: true, remaining_ms: 100_000, until: new Date(page.now() + 100_000).toISOString() } };
  page.window.ClowderApps.close();
  page.window.ClowderApps.open({});
  await settle();
  assert.equal(srv.sent('GET', /^\/xbot-api\/apps$/).length, 2, 'opening reads it fresh');
  assert.match(seen(row('wechat')), /1:40$/);
  page.window.ClowderApps.close();
  assert.equal(page.timers.size, 0, 'nothing counts down while the dialog is closed');
});

test('a 409 that says 微信 is not on leads to a fresh read and the server\'s sentence; a start cut short while the engine goes on is shown as starting, not as a failure', async () => {
  const { srv, row, body } = await opened((s) => { s.wechat = { ...s.wechat, state: 'on', authorization: { active: false, remaining_ms: 0 } }; });
  row('wechat').click();
  await settle();
  srv.on.set('POST /xbot-api/apps/wechat/authorize', () => { srv.wechat = { ...srv.wechat, state: 'off', authorization: undefined }; throw fail(409, '先打开微信这个应用', 'app_not_on'); });
  buttonOf(body(), '授权 10 分钟').click();
  await settle();
  assert.equal(srv.sent('GET', /\/wechat$/).length, 1, 'read again');
  assert.equal(seen(one(body(), '.ap-state')), '未打开');
  assert.equal(seen(one(body(), '.ap-note')), '先打开微信这个应用。');
  assert.equal(one(body(), '.ap-note').getAttribute('role'), 'alert');
  // A connect whose request is cut while the engine goes on: the fresh read says starting; no failure is shown.
  srv.on.delete('POST /xbot-api/apps/wechat/authorize');
  srv.starts = 3;
  srv.on.set('POST /xbot-api/apps/wechat/connect', () => { srv.wechat = { ...srv.wechat, state: 'starting' }; throw fail(503, '服务出了点问题，请稍后再试。'); });
  buttonOf(body(), '打开').click();
  await settle();
  assert.equal(seen(one(body(), '.ap-state')), '正在启动…');
  assert.equal(seen(one(body(), '.ap-note')), R.WECHAT_SLOW);
  assert.ok(!one(body(), '.ap-note').classList.contains('bad'));
  // One that really fails: said next to what was attempted, nothing optimistic left.
  const other = await opened();
  other.row('wechat').click();
  await settle();
  other.srv.on.set('POST /xbot-api/apps/wechat/connect', () => { throw fail(undefined, '连不上 clowder-bot'); });
  buttonOf(other.body(), '打开').click();
  await settle();
  assert.equal(seen(one(other.body(), '.ap-state')), '未打开');
  assert.equal(seen(one(other.body(), '.ap-note')), '没能打开微信：连不上 clowder-bot，稍后再试。');
});

test('微信 failed: why; 关闭 and 再试一次 at the top, the one sentence before them; unavailable: why, and no button that cannot work', async () => {
  const failed = await opened((s) => { s.wechat = { ...s.wechat, state: 'failed', reason: '没能启动', detail: 'X' }; });
  failed.row('wechat').click();
  await settle();
  assert.deepEqual(all(failed.body(), '.ap-hero-acts button').map((b) => seen(b)), ['关闭', '再试一次']);
  assert.equal(seen(one(failed.body(), '.ap-state')), '没能启动');
  assert.deepEqual(lines(one(failed.body(), '.ap-wechat')), ['没能启动', R.WECHAT_LEAD, '详情', '关闭', '再试一次', '说明']);
  assert.equal(said(failed.page.doc, buttonOf(failed.body(), '再试一次')), R.WECHAT_LEAD);
  assert.equal(buttonOf(failed.body(), '关闭').getAttribute('aria-describedby'), null, '关闭 needs no sentence');
  const none = await opened((s) => { s.wechat = { id: 'wechat', kind: 'wechat', title: '微信', state: 'unavailable', reason: '只在 Mac 上能用' }; });
  assert.equal(seen(none.row('wechat')), '微信只在 Mac 上能用');
  none.row('wechat').click();
  await settle();
  assert.equal(seen(one(none.body(), '.ap-state')), '只在 Mac 上能用');
  assert.deepEqual(all(none.body(), '.ap-view button').map((b) => seen(b)), [], 'not one button on the page');
  assert.deepEqual(lines(one(none.body(), '.ap-wechat')), ['只在 Mac 上能用'], 'why not: nothing else (the title says what it is)');
  // The list could not read 微信's state (docs/apps-api.md): not something this computer lacks — drawn as unknown,
  // and reading it again is what can be done; a read that fails again says so.
  const unread = await opened((s) => { s.wechat = { id: 'wechat', kind: 'wechat', title: '微信', state: 'unavailable', reason: '没能读到它的状态' }; });
  assert.ok(one(unread.row('wechat'), '.ap-mark').classList.contains('idle'));
  unread.row('wechat').click();
  await settle();
  let reads = 0;
  unread.srv.on.set('GET /xbot-api/apps/wechat', () => { if (reads++ === 0) throw fail(502, 'bad gateway'); return { ...unread.srv.wechat, state: 'off', reason: undefined, disclosure: WECHAT_DISCLOSURE, version: '0.1.0-alpha.7' }; });
  buttonOf(unread.body(), '再看一次').click();
  await settle();
  assert.equal(seen(one(unread.body(), '.ap-note')), '没能读到微信现在的状态：服务出了点问题，稍后再试。');
  buttonOf(unread.body(), '再看一次').click();
  await settle();
  assert.equal(seen(one(unread.body(), '.ap-state')), '未打开');
  buttonOf(unread.body(), '打开');
  assert.equal(unread.srv.sent('GET', /\/wechat$/).length, 2, 'only when asked');
  assert.equal(plain(R.wechatActions({ kind: 'wechat', state: 'unavailable', reason: '这台电脑上还没有它的程序包' })).length, 0);
});

test('添加自定义应用: the form, one line right above 添加 (every cat, unasked), how secrets are kept beside them once there is one, client checks that explain the button; the body sent, and 201 with failed is added', async () => {
  const { page, srv, body, title, row } = await opened();
  one(body(), '.ap-row-add').click();
  await settle();
  assert.equal(title(), '添加自定义应用');
  assert.equal(seen(one(body(), '.ap-lead')), R.CUSTOM_LEAD);
  const form = one(body(), 'form');
  const conseq = one(form, '.ap-conseq');
  assert.equal(seen(conseq), R.ADD_SCOPE, 'one line, not a list');
  const go = buttonOf(form, '添加');
  assert.equal(said(page.doc, go), R.ADD_SCOPE, 'heard as it is seen');
  const kids = form.children.filter(shown);
  assert.ok(kids.indexOf(conseq) < kids.indexOf(go.parent!), 'it comes before the button');
  assert.equal(all(form, '.ap-kept').length, 0, 'no word about how secrets are kept while there is none');
  // Pressed empty: it says why, at the field, and sends nothing.
  go.click();
  await settle();
  const nameIn = page.doc.activeElement as El;
  assert.equal(nameIn.getAttribute('aria-invalid'), 'true');
  assert.equal(srv.sent('POST', /custom$/).length, 0);
  assert.equal(seen(page.doc.getElementById(nameIn.getAttribute('aria-describedby')!)), '给它起个名字吧');
  // The two kinds are peers: one radio group.
  const kinds = all(form, '.ap-kind');
  assert.deepEqual(kinds.map((k) => [seen(k), k.getAttribute('role'), k.getAttribute('aria-checked'), k.getAttribute('tabindex')]), [['本机程序', 'radio', 'true', '0'], ['网址', 'radio', 'false', '-1']]);
  kinds[0]!.key('ArrowRight');
  assert.equal(kinds[1]!.getAttribute('aria-checked'), 'true');
  assert.equal(seen(conseq), R.ADD_SCOPE, 'the same for an address');
  kinds[1]!.key('ArrowLeft');
  // A program with two secrets, values masked, one peeked.
  nameIn.value = '我的笔记'; nameIn.dispatch('input');
  const panel = one(form, '.ap-kind-panel[data-kind="program"]');
  const [programIn] = all(panel, 'input');
  programIn!.value = 'npx';
  (one(panel, 'textarea') as Any).value = '-y\nnotes-mcp@1.2.3\n';
  buttonOf(panel, '添加环境变量').click();
  buttonOf(panel, '添加环境变量').click();
  const rows = all(panel, '.ap-secret');
  assert.equal(rows.length, 2);
  // How they are kept: beside them, once (the value fields are described by it).
  assert.deepEqual(all(panel, '.ap-kept').map((n) => seen(n)), [R.SECRETS_KEPT]);
  assert.ok((one(rows[0]!, '.ap-secret-in').getAttribute('aria-describedby') || '').split(' ').includes(one(panel, '.ap-kept').id));
  for (const [r, [k, v]] of rows.map((r, i) => [r, [['NOTES_TOKEN', 'tok-1'], ['NOTES_ROOT', '/Users/me']][i]!] as const)) {
    (one(r, '.ap-secret-name') as Any).value = k;
    const value = one(r, '.ap-secret-in') as Any;
    assert.equal(value.type, 'password', 'masked while typed');
    value.value = v;
  }
  const peek = one(rows[1]!, '.ap-peek');
  peek.click();
  assert.equal((one(rows[1]!, '.ap-secret-in') as Any).type, 'text');
  assert.equal(peek.getAttribute('aria-pressed'), 'true');
  srv.on.set('POST /xbot-api/apps/custom', (c: Call) => ({ id: 'custom:app-1', kind: 'custom', title: c.body.name, state: 'failed', reason: '几秒内没有回应', detail: 'Probe timeout after 7000ms', source: { type: 'program', program: 'npx', args: c.body.args, secrets: Object.keys(c.body.secrets) } }));
  go.click();
  assert.equal(seen(go), '正在添加…');
  await settle();
  const sent = srv.sent('POST', /custom$/);
  assert.equal(sent.length, 1);
  const { idempotencyKey, ...sentBody } = sent[0].body;
  assert.match(idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(sentBody, { name: '我的笔记', program: 'npx', args: ['-y', 'notes-mcp@1.2.3'], secrets: { NOTES_TOKEN: 'tok-1', NOTES_ROOT: '/Users/me' } });
  // 201 failed: added — its page, in those terms, with 再试一次, its secrets by name and 移除.
  assert.equal(title(), '我的笔记');
  assert.equal(seen(one(body(), '.ap-state')), '几秒内没有回应');
  assert.equal(seen(one(body(), '.ap-note')), '已经加上了。', 'that it is in; the state line says it does not answer');
  assert.ok(!one(body(), '.ap-note').classList.contains('bad'));
  assert.equal(seen(one(body(), '.ap-hint')), R.SLOW_HINT, 'npx may only have been slow the first time');
  buttonOf(body(), '再试一次');
  assert.deepEqual(all(body(), '.ap-names code').map((c) => seen(c)), ['NOTES_TOKEN', 'NOTES_ROOT']);
  buttonOf(body(), '移除');
  assert.equal(seen(one(body(), '.ap-cmd')), 'npx -y notes-mcp@1.2.3');
  // The values are nowhere on the page any more.
  for (const input of page.doc.querySelectorAll('input')) assert.ok(!['tok-1', '/Users/me'].includes((input as Any).value));
  assert.ok(!seen(page.doc.body).includes('tok-1'));
  // Back on the list, it is there.
  page.doc.activeElement.key('Escape');
  assert.equal(seen(one(row('custom:app-1'), '.ap-st-word')), '几秒内没有回应');
});

test('a lost answer: the list is read again before 添加 is offered again, and the same content goes under the same key; changed content is a new request; a 4xx is the server\'s sentence', async () => {
  const { srv, body } = await opened();
  one(body(), '.ap-row-add').click();
  await settle();
  const form = one(body(), 'form');
  const [nameIn, programIn] = all(form, 'input');
  nameIn!.value = 'Notes'; programIn!.value = 'node';
  let attempt = 0;
  srv.on.set('POST /xbot-api/apps/custom', () => {
    attempt++;
    if (attempt === 1) { srv.add('custom:notes', 'Notes', { type: 'program', program: 'node', args: [], secrets: [] }); throw fail(undefined, '连不上 clowder-bot'); }
    if (attempt === 2) throw fail(400, 'name: 请起个名字');
    return { id: 'custom:notes', kind: 'custom', title: 'Notes', state: 'on', tools: [], source: { type: 'program', program: 'node', args: [], secrets: [] } };
  });
  const before = srv.sent('GET', /^\/xbot-api\/apps$/).length;
  buttonOf(form, '添加').click();
  await settle();
  assert.equal(srv.sent('GET', /^\/xbot-api\/apps$/).length, before + 1, 'read the list again first');
  assert.equal(seen(one(form, '.ap-error')), R.ADD_UNSURE);
  // It may be there already: a way to it, by name.
  assert.equal(seen(one(form, '.ap-twin')), '打开「Notes」');
  const key1 = srv.sent('POST', /custom$/)[0].body.idempotencyKey;
  buttonOf(form, '添加').click();
  await settle();
  assert.equal(srv.sent('POST', /custom$/)[1].body.idempotencyKey, key1, 'same content, same key');
  assert.equal(seen(one(form, '.ap-error')), '请起个名字。', 'the server\'s sentence, without its field path');
  // A refusal ends that attempt: the next is a new request; and changed content is new anyway.
  buttonOf(form, '添加').click();
  await settle();
  assert.notEqual(srv.sent('POST', /custom$/)[2].body.idempotencyKey, key1);
  const page2 = await opened();
  one(page2.body(), '.ap-row-add').click();
  await settle();
  const f2 = one(page2.body(), 'form');
  const [n2, p2] = all(f2, 'input');
  n2!.value = 'A'; p2!.value = 'node';
  page2.srv.on.set('POST /xbot-api/apps/custom', () => { throw fail(503); });
  buttonOf(f2, '添加').click();
  await settle();
  buttonOf(f2, '添加').click();
  await settle();
  n2!.value = 'B';
  buttonOf(f2, '添加').click();
  await settle();
  const keys = page2.srv.sent('POST', /custom$/).map((c: Call) => c.body.idempotencyKey);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[1], keys[2]);
});

test('a whole command line pasted into 程序 is split into the program and its arguments, one per line; anything else is pasted as it is', async () => {
  const { body } = await opened();
  one(body(), '.ap-row-add').click();
  await settle();
  const panel = one(body(), '.ap-kind-panel[data-kind="program"]');
  const programIn = all(panel, 'input')[0] as Any, args = one(panel, 'textarea') as Any;
  const paste = (text: string) => programIn.dispatch('paste', { clipboardData: { getData: () => text } });
  let ev = paste('npx -y @modelcontextprotocol/server-filesystem "/Users/me/My Docs"');
  assert.ok(ev.defaultPrevented);
  assert.equal(programIn.value, 'npx');
  assert.equal(args.value, '-y\n@modelcontextprotocol/server-filesystem\n/Users/me/My Docs');
  assert.equal(seen(one(panel, '.ap-split')), '参数已经分到下面。');
  programIn.dispatch('input');
  assert.equal(all(panel, '.ap-split').length, 0);
  // Arguments already written, or a pipe: as pasted.
  programIn.value = '';
  ev = paste('node server.js');
  assert.ok(!ev.defaultPrevented, 'the arguments box is not empty: nothing is replaced');
  args.value = '';
  ev = paste('cat x | node');
  assert.ok(!ev.defaultPrevented);
});

test('a custom app\'s page: its name (renamed in place), what it is, its secrets by name (a new value or one more; never shown), its tools with descriptions on request, 再检查', async () => {
  const tools = Array.from({ length: 40 }, (_, i) => ({ name: 'tool_' + i, ...(i % 2 ? { description: 'Does thing ' + i } : {}) }));
  const { page, srv, row, body, title } = await opened((s) => s.add('custom:linear', 'Linear', { type: 'url', url: 'https://mcp.linear.app/mcp', secrets: ['Authorization'] }, { state: 'on', tools }));
  row('custom:linear').click();
  await settle();
  assert.equal(title(), 'Linear');
  assert.equal(seen(one(body(), '.ap-state')), '已连接');
  assert.equal(seen(one(body(), '.ap-cmd')), 'https://mcp.linear.app/mcp');
  assert.equal(seen(one(body(), '.ap-sec h3')), '请求头');
  assert.equal(seen(all(body(), '.ap-sec h3')[1]!), '工具 · 40');
  const items = all(body(), '.ap-tool');
  assert.equal(items.length, 40);
  assert.equal(all(body(), '.ap-tool-desc').length, 0, 'descriptions only on request');
  const b = one(items[1]!, '.ap-tool-btn');
  b.click();
  assert.equal(b.getAttribute('aria-expanded'), 'true');
  assert.equal(seen(one(items[1]!, '.ap-tool-desc')), 'Does thing 1');
  assert.equal(all(items[0]!, 'button').length, 0, 'a tool without a description is only its name');
  // Rename: the title is a button; Enter saves {name} and the answer is shown.
  const name = one(page.doc.querySelector('.ap-title') as El, '.ap-name');
  name.click();
  const input = page.doc.activeElement as Any;
  assert.equal(input.value, 'Linear');
  input.value = 'Linear 工作';
  input.key('Enter');
  await settle();
  assert.deepEqual(srv.sent('PATCH', /custom%3Alinear$/)[0].body, { name: 'Linear 工作' });
  assert.equal(title(), 'Linear 工作');
  assert.equal(page.doc.activeElement, one(page.doc.querySelector('.ap-title') as El, '.ap-name'));
  // Escape in the field keeps the old name and stays on the page.
  one(page.doc.querySelector('.ap-title') as El, '.ap-name').click();
  (page.doc.activeElement as Any).value = 'zzz';
  page.doc.activeElement.key('Escape');
  assert.equal(title(), 'Linear 工作');
  assert.equal(srv.sent('PATCH', /linear$/).length, 1);
  // A new value: masked, saved by name; an empty one is refused with why (and nothing is sent).
  buttonOf(body(), '换一个值').click();
  const value = page.doc.activeElement as Any;
  assert.equal(value.type, 'password');
  // How it is kept, beside the field while a value is typed (round 5), and the field is described by it.
  assert.equal(seen(one(body(), '.ap-secret-edit .ap-kept')), R.SECRETS_KEPT);
  assert.ok((value.getAttribute('aria-describedby') || '').split(' ').includes(one(body(), '.ap-secret-edit .ap-kept').id));
  value.value = '';
  buttonOf(body(), '保存').click();
  await settle();
  assert.equal(seen(one(body(), '.ap-secret-edit .ap-err')), R.EMPTY_SECRET);
  assert.equal(srv.sent('PATCH', /linear$/).length, 1);
  value.value = 'Bearer new';
  value.key('Enter');
  await settle();
  assert.deepEqual(srv.sent('PATCH', /linear$/)[1].body, { secrets: { Authorization: 'Bearer new' } });
  assert.equal(seen(one(body(), '.ap-note')), '「Authorization」已保存。');
  assert.ok(!seen(page.doc.body).includes('Bearer new'));
  // One more.
  buttonOf(body(), '添加').click();
  const [k, v] = all(body(), '.ap-adding input') as Any[];
  k.value = 'X-Workspace'; v.value = 'home';
  buttonOf(body(), '保存').click();
  await settle();
  assert.deepEqual(srv.sent('PATCH', /linear$/)[2].body, { secrets: { 'X-Workspace': 'home' } });
  assert.deepEqual(all(body(), '.ap-names code').map((c) => seen(c)), ['Authorization', 'X-Workspace']);
  // 再检查: one fresh read of its detail.
  const reads = srv.sent('GET', /custom%3Alinear$/).length;
  buttonOf(body(), '再检查').click();
  assert.equal(seen(one(body(), '.ap-check')), '正在检查…');
  await settle();
  assert.equal(srv.sent('GET', /custom%3Alinear$/).length, reads + 1);
});

test('移除 is confirmed with its consequence in the app\'s own vocabulary; it goes, and focus lands on the next row; a lost answer is checked against the list', async () => {
  const { page, srv, row, body, title } = await opened((s) => {
    s.add('custom:a', 'A', { type: 'program', program: 'node', args: [], secrets: [] });
    s.add('custom:b', 'B', { type: 'program', program: 'node', args: [], secrets: [] });
  });
  row('custom:a').click();
  await settle();
  buttonOf(body(), '移除').click();
  const confirm = page.doc.querySelector('.ap-confirm') as El;
  assert.equal(confirm.getAttribute('role'), 'alertdialog');
  assert.equal(seen(confirm.querySelector('h2')), '移除「A」？');
  assert.equal(seen(confirm.querySelector('.note')), R.REMOVE_NOTE);
  assert.equal(seen(page.doc.activeElement), '取消', 'the safe choice has focus');
  assert.equal((page.doc.querySelector('.ap-modal') as El).inert, true);
  // Escape closes only the confirmation.
  page.doc.activeElement.key('Escape');
  assert.equal(page.doc.querySelector('.ap-confirm'), null);
  assert.equal(title(), 'A');
  assert.equal(seen(page.doc.activeElement), '移除');
  buttonOf(body(), '移除').click();
  const go = buttonOf(page.doc.querySelector('.ap-confirm') as El, '移除');
  go.click();
  await settle();
  assert.equal(srv.sent('DELETE', /custom%3Aa$/).length, 1);
  assert.equal(page.doc.querySelector('.ap-confirm'), null);
  assert.equal(title(), '应用');
  assert.equal(row('custom:a'), null);
  assert.equal(page.doc.activeElement, row('custom:b'));
  // A lost answer: the list says whether it is still there.
  row('custom:b').click();
  await settle();
  srv.on.set('DELETE /xbot-api/apps/custom%3Ab', () => { throw fail(undefined); });
  buttonOf(body(), '移除').click();
  buttonOf(page.doc.querySelector('.ap-confirm') as El, '移除').click();
  await settle();
  assert.equal(seen((page.doc.querySelector('.ap-confirm') as El).querySelector('.error')), '没能确认移除了没有。它还在列表里，可以再试一次。');
  srv.on.set('DELETE /xbot-api/apps/custom%3Ab', () => { srv.custom = []; throw fail(503); });
  buttonOf(page.doc.querySelector('.ap-confirm') as El, '移除').click();
  await settle();
  assert.equal(page.doc.querySelector('.ap-confirm'), null, 'gone from the list: removed');
  assert.equal(page.doc.activeElement, one(body(), '.ap-row-add'));
});

test('an app removed elsewhere (404 on its check) leaves the list, which is read again; a list that cannot be read says so and offers to try again', async () => {
  const gone = await opened((s) => { s.add('custom:x', 'X', { type: 'program', program: 'node', args: [], secrets: [] }); s.on.set('GET /xbot-api/apps/custom%3Ax', () => { s.custom = []; throw fail(404, '没有这个应用'); }); });
  await settle();
  assert.equal(gone.row('custom:x'), null);
  assert.equal(gone.srv.sent('GET', /^\/xbot-api\/apps$/).length, 2);
  const page = load(), srv = server(page);
  let n = 0;
  srv.on.set('GET /xbot-api/apps', () => { if (n++ === 0) throw fail(undefined, '连不上 clowder-bot'); return { apps: [srv.wechat] }; });
  page.window.ClowderApps.init({ api: srv.api, icon: icon(page.doc), now: page.now });
  page.window.ClowderApps.open({});
  await settle();
  const body = page.doc.querySelector('.ap-body') as El;
  assert.equal(seen(one(body, '.ap-fail .ap-note')), '没能读到应用：连不上 clowder-bot，稍后再试。');
  assert.equal(all(body, '.ap-row').length, 0, 'no rows that were not read');
  buttonOf(body, '再试一次').click();
  await settle();
  assert.deepEqual(all(body, '.ap-row').map((r) => r.dataset.app || 'add'), ['wechat', 'add']);
});

test('what the dialog shows speaks the app\'s everyday words: no engine words anywhere it can be seen or heard', async () => {
  const { page, row, body } = await opened((s) => {
    s.wechat = { ...s.wechat, state: 'on', authorization: { active: false, remaining_ms: 0 } };
    s.add('custom:a', 'A', { type: 'program', program: 'node', args: [], secrets: ['K'] });
  });
  const words: string[] = [];
  const grab = () => {
    for (const n of page.doc.querySelectorAll('.ap-card *')) {
      for (const k of n.kids) if (k instanceof TextNode) words.push(k.data);
      for (const a of ['aria-label', 'data-tip', 'placeholder', 'title']) if (n.getAttribute(a)) words.push(n.getAttribute(a)!);
    }
  };
  grab();
  row('wechat').click(); await settle(); grab();
  page.doc.activeElement.key('Escape');
  row('custom:a').click(); await settle(); grab();
  page.doc.activeElement.key('Escape');
  one(body(), '.ap-row-add').click(); await settle(); grab();
  const said = words.join('\n');
  // Not ours: the plugin's own words, quoted. One exception of ours: the consent sentence that names where the
  // 微信 text goes, the Agent and its model — the truth about that outranks the everyday-words rule (review r1, 6).
  assert.ok(said.includes(R.WECHAT_NOTES[1]!));
  const ours = [WECHAT_DISCLOSURE, R.WECHAT_NOTES[1]!].reduce((text, q) => text.split(q).join(''), said);
  for (const word of [/(?<![\w-])bots?\b/i, /xbot/i, /(?<![\w-])threads?\b/i, /sessions?\b/i, /会话/, /线程/, /原生/, /调用/, /模型/, /Clowder AI/i, /插件管理/, /operation/i])
    assert.doesNotMatch(ours, word);
});

// ---------------------------------------------------------------- review r1 (Codex, read-only, 2026-11-26)
// Each test here failed on the page as it was before the fix it covers.
const on = (left?: number) => (s: Any) => {
  s.wechat = { ...s.wechat, state: 'on', authorization: left === undefined ? { active: false, remaining_ms: 0 } : { active: true, remaining_ms: left, until: new Date(1_700_000_000_000 + left).toISOString() } };
};
const stuck = (root: El) => all(root, 'button, input, textarea').filter((n) => n.disabled || (n as Any).readOnly).map((n) => n.tagName + ':' + (seen(n) || n.getAttribute('aria-label') || ''));

test('review r1 (1): a 微信 read that started before a write never paints over the write\'s answer — the countdown\'s read held across 关闭, and a list read held across 关闭', async () => {
  const { page, srv, row, body } = await opened(on(5_000));
  row('wechat').click();
  await settle();
  const stale = { ...srv.wechat }, gate = hold();
  srv.on.set('GET /xbot-api/apps/wechat', () => gate.promise.then(() => stale));
  await page.advance(5_000);
  assert.equal(srv.sent('GET', /\/wechat$/).length, 1, 'the countdown\'s one read is on its way');
  buttonOf(body(), '关闭').click();
  await settle();
  assert.equal(seen(one(body(), '.ap-state')), '未打开');
  gate.release();
  await settle();
  assert.equal(seen(one(body(), '.ap-state')), '未打开', 'the read that began before 关闭 is not evidence after it');
  assert.equal(all(body(), '.ap-clock').length, 0);
  page.doc.activeElement.key('Escape');
  assert.equal(seen(row('wechat')), '微信未打开');
  // The list's own read is a read of 微信 too.
  const listGate = hold();
  const second = await opened((s) => {
    on()(s);
    s.add('custom:x', 'X', { type: 'program', program: 'node', args: [], secrets: [] });
    s.on.set('GET /xbot-api/apps/custom%3Ax', () => { s.custom = []; throw fail(404, '没有这个应用'); });
    let lists = 0;
    s.on.set('GET /xbot-api/apps', () => { const now = s.listNow(); return lists++ === 0 ? now : listGate.promise.then(() => now); });
  });
  assert.equal(second.srv.sent('GET', /^\/xbot-api\/apps$/).length, 2, 'x was gone: the list is being read again');
  second.row('wechat').click();
  await settle();
  buttonOf(second.body(), '关闭').click();
  await settle();
  listGate.release();
  await settle();
  assert.equal(seen(one(second.body(), '.ap-state')), '未打开');
});

test('review r1 (2): a read of 微信 that fails is not evidence — after a failed 撤销 whose re-read fails too, and when the zero-time read fails, the open chat is unknown (no countdown, 再看一次, 撤销) and the row has no time', async () => {
  const { page, srv, row, body } = await opened(on(300_000));
  row('wechat').click();
  await settle();
  srv.on.set('POST /xbot-api/apps/wechat/revoke', () => { throw fail(undefined, '连不上 clowder-bot'); });
  srv.on.set('GET /xbot-api/apps/wechat', () => { throw fail(undefined, '连不上 clowder-bot'); });
  buttonOf(body(), '撤销').click();
  await settle();
  assert.equal(all(body(), '.ap-clock').length, 0, 'the last known countdown is not shown as if it were current');
  assert.equal(seen(one(body(), '.ap-open')), R.OPEN_CHAT + R.OPEN_UNKNOWN + '再看一次撤销');
  assert.equal(seen(one(body(), '.ap-auth-note')), '没能撤销：连不上 clowder-bot，稍后再试。', 'what failed, under the row where it was tried');
  assert.equal(seen(one(body(), '.ap-state')), '已打开', 'reading by name and 关闭 as before');
  const reads = srv.sent('GET', /\/wechat$/).length;
  await page.advance(600_000);
  assert.equal(srv.sent('GET', /\/wechat$/).length, reads, 'nothing counts down, nothing is read by itself');
  page.doc.activeElement.key('Escape');
  assert.equal(seen(row('wechat')), '微信已打开', 'the row has no time');
  // The zero-time read fails.
  const zero = await opened(on(5_000));
  zero.row('wechat').click();
  await settle();
  zero.srv.on.set('GET /xbot-api/apps/wechat', () => { throw fail(502); });
  await zero.page.advance(5_000);
  assert.equal(all(zero.body(), '.ap-clock').length, 0, 'no 0:00 left standing');
  assert.equal(seen(one(zero.body(), '.ap-open')), R.OPEN_CHAT + R.OPEN_UNKNOWN + '再看一次撤销');
});

test('review r1 (3): a custom app\'s check belongs to what it checked — a changed source on a list read, a failed 再检查 and a write whose answer was lost each put it back to 未检查 / 没能检查, with no tools', async () => {
  const yGate = hold();
  const { srv, row, body } = await opened((s) => {
    s.add('custom:a', 'A', { type: 'program', program: 'node', args: ['a.js'], secrets: ['K'] });
    s.add('custom:y', 'Y', { type: 'program', program: 'node', args: [], secrets: [] });
    s.on.set('GET /xbot-api/apps/custom%3Ay', () => yGate.promise.then(() => { s.custom = s.custom.filter((x: Any) => x.id !== 'custom:y'); throw fail(404, '没有这个应用'); }));
  });
  assert.equal(seen(one(row('custom:a'), '.ap-st-word')), '已连接');
  // Changed elsewhere: another program, other secret names. y turns out gone, so the list is read again.
  srv.custom[0].source = { type: 'program', program: 'missing-new-program', args: [], secrets: ['OTHER'] };
  yGate.release();
  await settle();
  assert.equal(seen(one(row('custom:a'), '.ap-st-word')), '未检查', 'what was checked is not what is there now');
  row('custom:a').click();
  await settle();
  assert.equal(all(body(), '.ap-tool').length, 0, 'no tools from the old program');
  assert.equal(seen(one(body(), '.ap-cmd')), 'missing-new-program');
  // A failed 再检查.
  const b = await opened((s) => s.add('custom:b', 'B', { type: 'program', program: 'node', args: [], secrets: ['K'] }));
  b.row('custom:b').click();
  await settle();
  b.srv.on.set('GET /xbot-api/apps/custom%3Ab', () => { throw fail(500); });
  buttonOf(b.body(), '再检查').click();
  await settle();
  assert.equal(seen(one(b.body(), '.ap-state')), '没能检查');
  assert.equal(all(b.body(), '.ap-tool').length, 0);
  // A secret write whose answer was lost.
  const c = await opened((s) => s.add('custom:c', 'C', { type: 'program', program: 'node', args: [], secrets: ['K'] }));
  c.row('custom:c').click();
  await settle();
  c.srv.on.set('PATCH /xbot-api/apps/custom%3Ac', () => { throw fail(undefined, '连不上 clowder-bot'); });
  buttonOf(c.body(), '换一个值').click();
  (c.page.doc.activeElement as Any).value = 'new';
  buttonOf(c.body(), '保存').click();
  await settle();
  assert.equal(seen(one(c.body(), '.ap-state')), '没能检查', 'it may now run with the new value or the old one');
  assert.equal(all(c.body(), '.ap-tool').length, 0);
});

test('review r1 (4): one write at a time per app — a rename started while a secret is being saved waits its turn, nothing is left locked; a rename made by leaving the field', async () => {
  const gates: Array<ReturnType<typeof hold>> = [];
  const { page, srv, row, body, title } = await opened((s) => {
    s.add('custom:a', 'A', { type: 'program', program: 'node', args: [], secrets: ['K'] });
    s.on.set('PATCH /xbot-api/apps/custom%3Aa', (c: Call) => { const g = hold(); gates.push(g); return g.promise.then(() => s.fallback(c)); });
  });
  row('custom:a').click();
  await settle();
  buttonOf(body(), '换一个值').click();
  (page.doc.activeElement as Any).value = 'v2';
  buttonOf(body(), '保存').click();
  await settle();
  one(page.doc.querySelector('.ap-title') as El, '.ap-name').click();
  const input = page.doc.activeElement as Any;
  input.value = 'A2';
  input.key('Enter');
  await settle();
  assert.equal(srv.sent('PATCH', /custom%3Aa$/).length, 1, 'the rename waits for the secret');
  assert.equal(srv.sent('PATCH', /custom%3Aa$/)[0].signal.aborted, false, 'the secret save is not cut off');
  gates[0]!.release();
  await settle();
  assert.equal(srv.sent('PATCH', /custom%3Aa$/).length, 2);
  assert.deepEqual(srv.sent('PATCH', /custom%3Aa$/).map((c: Call) => Object.keys(c.body)[0]), ['secrets', 'name']);
  gates[1]!.release();
  await settle();
  assert.equal(title(), 'A2');
  assert.deepEqual(stuck(one(body(), '.ap-app')), [], 'no control is left disabled or read-only');
  // Leaving the field saves too.
  one(page.doc.querySelector('.ap-title') as El, '.ap-name').click();
  const field = page.doc.activeElement as Any;
  field.value = 'A3';
  field.dispatch('blur');
  await settle();
  gates[2]!.release();
  await settle();
  assert.deepEqual(srv.sent('PATCH', /custom%3Aa$/)[2].body, { name: 'A3' });
  assert.equal(title(), 'A3');
  assert.deepEqual(stuck(one(body(), '.ap-app')), []);
});

test('review r1 (5), as of round 5: a button is described by what a sighted person reads before pressing it, no more — 打开 by the one sentence, 授权 10 分钟 by its row, 添加 by its line; every fact that left the surface is in 说明; the false sentences are nowhere on the page', async () => {
  const { page, srv, row, body } = await opened();
  row('wechat').click();
  await settle();
  assert.equal(said(page.doc, buttonOf(body(), '打开')), R.WECHAT_LEAD);
  // Whatever left the surface is one click away.
  const more = buttonOf(body(), '说明');
  more.click();
  const inside = seen(page.doc.getElementById(more.getAttribute('aria-controls')!));
  for (const fact of ['只读', '不发消息', '不点链接', '聊天记录库', '截图认字', '截图不保存', 'Agent 和模型', '执行记录', '短暂切到前面', '标为已读', '屏幕录制', '辅助功能', 'Plugin Hub', WECHAT_DISCLOSURE, R.SOURCE_NOTE])
    assert.ok(inside.includes(fact), '说明: ' + fact);
  // Every state's words, seen or heard: none of the false sentences.
  const words: string[] = [];
  const grab = () => {
    words.push(seen(body()));
    for (const n of body().querySelectorAll('*')) for (const a of ['aria-label', 'data-tip', 'title']) if (n.getAttribute(a)) words.push(n.getAttribute(a)!);
    for (const b of all(body(), 'button')) words.push(said(page.doc, b));
  };
  grab();
  buttonOf(body(), '打开').click();
  await settle();
  grab();
  const authorize = buttonOf(body(), '授权 10 分钟');
  assert.equal(said(page.doc, authorize), R.OPEN_CHAT + R.OPEN_OFF, 'its row');
  authorize.click();
  await settle();
  grab();
  srv.on.set('POST /xbot-api/apps/wechat/revoke', () => { throw fail(undefined, '连不上 clowder-bot'); });
  srv.on.set('GET /xbot-api/apps/wechat', () => { throw fail(undefined, '连不上 clowder-bot'); });
  buttonOf(body(), '撤销').click();
  await settle();
  grab();
  const text = words.join('\n');
  assert.ok(text.includes(R.OPEN_UNKNOWN), 'the unknown state was among them');
  for (const wrong of [/每次都会先问|会先问你/, /不能读|读不了|还不能/, /会请你允许|会弹出|系统会问/, /可以读微信/])
    assert.doesNotMatch(text, wrong);
  // 添加: its line.
  page.doc.activeElement.key('Escape');
  one(body(), '.ap-row-add').click();
  await settle();
  assert.equal(said(page.doc, buttonOf(body(), '添加')), R.ADD_SCOPE);
});

test('review r1 (6): the consent sentence names both recipients (the Agent and the model); 「插件原文」 keeps the plugin\'s words verbatim with one line of ours that corrects them', async () => {
  assert.equal(R.WECHAT_NOTES[1], '认出的文字会和你发给猫猫的话一样，交给它用的 Agent 和模型，并留在那段聊天的执行记录里。');
  const { page, row, body } = await opened();
  row('wechat').click();
  await settle();
  buttonOf(body(), '说明').click();
  assert.ok(seen(one(body(), '.ap-more-box')).includes(R.WECHAT_NOTES[1]!), 'in 说明, word for word');
  const box = one(body(), '.ap-source');
  assert.ok(seen(box).includes(WECHAT_DISCLOSURE), 'verbatim');
  assert.equal(seen(one(box, '.ap-source-note')), R.SOURCE_NOTE);
  for (const fact of ['不会每次问你', '按名字读', '猫猫自己确认']) assert.ok(R.SOURCE_NOTE.includes(fact), fact);
  // Only where the plugin says it: another version's words get no correction they do not need.
  const other = await opened((s) => { s.wechat = { ...s.wechat, disclosure: '不会保存截图。', version: '0.2.0' }; });
  other.row('wechat').click();
  await settle();
  buttonOf(other.body(), '说明').click();
  assert.equal(all(other.body(), '.ap-source-note').length, 0);
  void page;
});

test('review r1 (7): a pending write keeps focus on something that can hold it, and a pending removal can be left — Escape abandons it in the page, the list is read again, nothing is said about an outcome nobody knows', async () => {
  const gate = hold();
  const { page, srv, row, body, title } = await opened((s) => {
    s.add('custom:a', 'A', { type: 'program', program: 'node', args: [], secrets: ['K'] });
    s.on.set('DELETE /xbot-api/apps/custom%3Aa', (c: Call) => gate.promise.then(() => s.fallback(c)));
  });
  row('custom:a').click();
  await settle();
  buttonOf(body(), '移除').click();
  const confirm = page.doc.querySelector('.ap-confirm') as El;
  const go = buttonOf(confirm, '移除');
  go.focus();
  go.click();
  await settle();
  assert.ok(focusIsUsable(page.doc) && confirm.contains(page.doc.activeElement), 'focus waits inside the confirmation, on something that can hold it');
  // Escape while it is pending: the confirmation goes, the request is given up here, the list is read again.
  const lists = srv.sent('GET', /^\/xbot-api\/apps$/).length;
  page.doc.activeElement.key('Escape');
  await settle();
  assert.equal(page.doc.querySelector('.ap-confirm'), null);
  assert.equal(srv.sent('DELETE', /custom%3Aa$/)[0].signal.aborted, true);
  assert.equal(srv.sent('GET', /^\/xbot-api\/apps$/).length, lists + 1);
  assert.equal(title(), 'A', 'still in the list: still on its page');
  assert.equal(seen(page.doc.activeElement), '移除');
  for (const words of ['移除了', '没能确认', '没能移除', '已经不在']) assert.ok(!seen(page.doc.body).includes(words), words);
  // The secret editor's 保存, pending.
  const sGate = hold();
  srv.on.set('PATCH /xbot-api/apps/custom%3Aa', (c: Call) => sGate.promise.then(() => srv.fallback(c)));
  buttonOf(body(), '换一个值').click();
  (page.doc.activeElement as Any).value = 'v';
  const save = buttonOf(body(), '保存');
  save.focus();
  save.click();
  await settle();
  assert.ok(focusIsUsable(page.doc) && one(body(), '.ap-secret-edit').contains(page.doc.activeElement), 'focus waits in the editor');
  sGate.release();
  await settle();
});

test('review r1 (8): an update that hides or replaces what has focus puts focus on the line that says the new state — 撤销 when the time runs out or the status turns unknown, a tool when the list is replaced', async () => {
  for (const [answer, line] of [[{ active: false, remaining_ms: 0 }, R.OPEN_OFF], [undefined, R.OPEN_UNKNOWN]] as const) {
    const { page, srv, row, body } = await opened(on(5_000));
    row('wechat').click();
    await settle();
    srv.on.set('GET /xbot-api/apps/wechat', () => ({ ...srv.wechat, authorization: answer }));
    buttonOf(body(), '撤销').focus();
    await page.advance(5_000);
    assert.ok(focusIsUsable(page.doc), 'focus is somewhere it can be');
    assert.equal(seen(page.doc.activeElement), line);
  }
  const tools = (names: string[]) => names.map((name) => ({ name, description: 'About ' + name }));
  const { page, srv, row, body } = await opened((s) => s.add('custom:t', 'T', { type: 'url', url: 'https://t.dev/mcp', secrets: [] }, { state: 'on', tools: tools(['a', 'b']) }));
  row('custom:t').click();
  await settle();
  all(body(), '.ap-tool-btn')[1]!.focus();
  srv.custom[0].checked = { state: 'on', tools: tools(['a', 'b', 'c']) };
  buttonOf(body(), '再检查').click();
  await settle();
  assert.ok(focusIsUsable(page.doc));
  srv.custom[0].checked = { state: 'failed', reason: '连不上这个网址' };
  all(body(), '.ap-tool-btn')[0]!.focus();
  buttonOf(body(), '再检查').click();
  await settle();
  assert.ok(focusIsUsable(page.doc), 'the tools went with the connection: focus did not go with them');
});

test('review r1 (9): an app found gone while its removal is being confirmed — the confirmation goes first, then the page, and focus lands on a list control that is still there', async () => {
  const gate = hold();
  const { page, row, body, title } = await opened((s) => {
    s.add('custom:a', 'A', { type: 'program', program: 'node', args: [], secrets: [] });
    s.add('custom:b', 'B', { type: 'program', program: 'node', args: [], secrets: [] });
    s.on.set('GET /xbot-api/apps/custom%3Aa', () => gate.promise.then(() => { s.custom = s.custom.filter((x: Any) => x.id !== 'custom:a'); throw fail(404, '没有这个应用'); }));
  });
  row('custom:a').click();
  await settle();
  buttonOf(body(), '移除').click();
  assert.ok(page.doc.querySelector('.ap-confirm'));
  gate.release();
  await settle();
  assert.equal(page.doc.querySelector('.ap-confirm'), null, 'the confirmation of an app that is not there goes');
  assert.equal(title(), '应用');
  assert.equal((page.doc.querySelector('.ap-modal') as El).inert, false);
  assert.ok(focusIsUsable(page.doc) && one(body(), '.ap-list').contains(page.doc.activeElement), 'focus on a list control that is still there');
  assert.equal(page.doc.activeElement, row('custom:b'));
  // On the list itself: a row found gone while it has focus hands focus to the row now in its place.
  const late = hold();
  const list = await opened((s) => {
    s.add('custom:c', 'C', { type: 'program', program: 'node', args: [], secrets: [] });
    s.add('custom:d', 'D', { type: 'program', program: 'node', args: [], secrets: [] });
    s.on.set('GET /xbot-api/apps/custom%3Ac', () => late.promise.then(() => { s.custom = s.custom.filter((x: Any) => x.id !== 'custom:c'); throw fail(404, '没有这个应用'); }));
  });
  list.row('custom:c').focus();
  late.release();
  await settle();
  assert.ok(focusIsUsable(list.page.doc));
  assert.equal(list.page.doc.activeElement, list.row('custom:d'));
});

test('review r1 (4, 2): an opening check skipped while a removal was on its way runs once the removal fails; a failed list read leaves 微信\'s ten minutes unknown', async () => {
  const gates = new Map<string, ReturnType<typeof hold>>();
  const del = hold();
  const { srv, row, body, page, voice } = await opened((s) => {
    on(300_000)(s);
    for (const x of ['a', 'b', 'c', 'd']) {
      s.add('custom:' + x, x.toUpperCase(), { type: 'program', program: 'node', args: [], secrets: [] });
      if (x !== 'd') { const g = hold(); gates.set(x, g); s.on.set('GET /xbot-api/apps/custom%3A' + x, (c: Call) => g.promise.then(() => s.fallback(c))); }
    }
    s.on.set('DELETE /xbot-api/apps/custom%3Ad', () => del.promise.then(() => { throw fail(500); }));
  });
  assert.equal(srv.sent('GET', /custom%3Ad$/).length, 0, 'three at a time: d waits');
  row('custom:d').click();
  await settle();
  buttonOf(body(), '移除').click();
  buttonOf(page.doc.querySelector('.ap-confirm') as El, '移除').click();
  await settle();
  gates.get('a')!.release();
  await settle();
  assert.equal(srv.sent('GET', /custom%3Ad$/).length, 0, 'not checked while its removal is on its way');
  del.release();
  await settle();
  assert.equal(srv.sent('GET', /custom%3Ad$/).length, 1, 'the removal failed: d is checked after all');
  gates.get('b')!.release();
  gates.get('c')!.release();
  await settle();
  assert.match(voice(), /^检查好了/, 'and the opening round is said when it ends');
  // A list read that fails is a failed read of 微信 too.
  page.doc.activeElement.key('Escape'); // the confirmation, which says the removal failed
  page.doc.activeElement.key('Escape'); // d's page
  assert.match(seen(row('wechat')), /授权还剩/);
  srv.on.set('GET /xbot-api/apps', () => { throw fail(undefined, '连不上 clowder-bot'); });
  srv.on.set('GET /xbot-api/apps/custom%3Aa', () => { srv.custom = srv.custom.filter((x: Any) => x.id !== 'custom:a'); throw fail(404, '没有这个应用'); });
  row('custom:a').click();
  await settle();
  buttonOf(body(), '再检查').click();
  await settle();
  assert.equal(seen(row('wechat')), '微信已打开', 'no time: it is not known now');
});

test('review r1 (10): after 再检查 and after a secret is saved, focus lands on the line that says the outcome', async () => {
  const { page, srv, row, body } = await opened((s) => s.add('custom:a', 'A', { type: 'program', program: 'node', args: [], secrets: ['K'] }));
  row('custom:a').click();
  await settle();
  buttonOf(body(), '再检查').focus();
  buttonOf(body(), '再检查').click();
  await settle();
  assert.equal(page.doc.activeElement, one(body(), '.ap-state'));
  assert.equal(seen(page.doc.activeElement), '已连接');
  srv.on.set('GET /xbot-api/apps/custom%3Aa', () => { throw fail(500); });
  buttonOf(body(), '再检查').focus();
  buttonOf(body(), '再检查').click();
  await settle();
  assert.equal(seen(page.doc.activeElement), '没能检查：服务出了点问题，稍后再试。');
  srv.on.delete('GET /xbot-api/apps/custom%3Aa');
  buttonOf(body(), '换一个值').click();
  (page.doc.activeElement as Any).value = 'v';
  buttonOf(body(), '保存').focus();
  buttonOf(body(), '保存').click();
  await settle();
  assert.equal(seen(page.doc.activeElement), '「K」已保存。');
});

test('review r1 (11, 12): at 390px every control of the dialog is 44px to touch; a connected app with no tools says so once', async () => {
  const css = read('client/public/apps-dialog.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const phone = /@media \(max-width: 560px\) \{([\s\S]*?)\n\}/.exec(css)![1]!;
  for (const sel of ['.ap-way-acts > button', '.ap-secret-acts > button', '.ap-add .modal-actions > button', '.ap-confirm .modal-actions > button', '.ap-tool-btn', '.ap-name', '.ap-name-input', '.ap-kind', '.ap-fail > button']) // a guard; the heights themselves were measured in a browser at 390px (item 54)
    assert.ok(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^{]*\\{[^}]*min-height: 44px').test(phone), sel);
  const { row, body } = await opened((s) => s.add('custom:e', 'E', { type: 'url', url: 'https://e.dev/mcp', secrets: [] }, { state: 'on', tools: [] }));
  row('custom:e').click();
  await settle();
  assert.equal(seen(all(body(), '.ap-sec h3')[0]!), '工具 · 0');
  assert.equal(all(body(), '.ap-tool').length, 0, 'not also 「它没有提供工具。」');
  assert.equal(all(body(), '.ap-tools').length, 0, 'nor an empty box under it');
});

test('review r1 (notes): a late success after the page gave up — after closing, after abandoning a removal — paints nothing and sends nothing', async () => {
  const gate = hold();
  const first = await opened((s) => {
    s.deaf = true;
    s.add('custom:a', 'A', { type: 'program', program: 'node', args: [], secrets: [] });
    s.on.set('GET /xbot-api/apps/custom%3Aa', () => gate.promise.then(() => ({ id: 'custom:a', kind: 'custom', title: 'A', state: 'failed', reason: '旧的回答', source: { type: 'program', program: 'node', args: [], secrets: [] } })));
  });
  first.page.window.ClowderApps.close();
  first.srv.on.delete('GET /xbot-api/apps/custom%3Aa');
  first.page.window.ClowderApps.open({});
  await settle();
  const calls = first.srv.calls.length;
  gate.release();
  await settle();
  assert.equal(first.srv.calls.length, calls, 'nothing sent because of it');
  assert.equal(seen(one(first.row('custom:a'), '.ap-st-word')), '已连接', 'the new dialog keeps its own answer');
  // A removal given up on, whose DELETE then succeeds after all.
  const del = hold();
  const { page, srv, row, body } = await opened((s) => {
    s.deaf = true;
    s.add('custom:b', 'B', { type: 'program', program: 'node', args: [], secrets: [] });
    s.on.set('DELETE /xbot-api/apps/custom%3Ab', (c: Call) => del.promise.then(() => s.fallback(c)));
  });
  row('custom:b').click();
  await settle();
  buttonOf(body(), '移除').click();
  buttonOf(page.doc.querySelector('.ap-confirm') as El, '移除').click();
  await settle();
  page.doc.activeElement.key('Escape');
  await settle();
  const before = srv.calls.length, words = seen(page.doc.body);
  del.release();
  await settle();
  assert.equal(srv.calls.length, before);
  assert.equal(seen(page.doc.body), words, 'nothing appears because of a request the page let go of');
});

// ---------------------------------------------------------------- review r2 (Codex's re-check, 2026-11-26)
// Each test here failed on the page as round 3 left it. The older answer is held, the newer one lands, then
// the older is released.
// 微信 on with the ten minutes running out in 5 s; custom:x is found gone on opening (so the list is read again,
// and that second list read is held: its answer is the list as it was when it was asked for).
const heldSecondList = (gate: ReturnType<typeof hold>, then: (s: Any, answer: Any) => Any = (_s, answer) => answer) => (s: Any) => {
  on(5_000)(s);
  s.add('custom:x', 'X', { type: 'program', program: 'node', args: [], secrets: [] });
  s.on.set('GET /xbot-api/apps/custom%3Ax', () => { s.custom = s.custom.filter((x: Any) => x.id !== 'custom:x'); throw fail(404, '没有这个应用'); });
  let lists = 0;
  s.on.set('GET /xbot-api/apps', () => { const answer = s.listNow(); return lists++ === 0 ? answer : gate.promise.then(() => then(s, answer)); });
};

test('review r2 (1): an older read of 微信 never paints over a newer one — a list read held across the zero-time read keeps the ten minutes over', async () => {
  const gate = hold();
  const { page, srv, row, body } = await opened(heldSecondList(gate));
  assert.equal(srv.sent('GET', /^\/xbot-api\/apps$/).length, 2, 'the second list read, asked for while 5 s were left, is on its way');
  row('wechat').click();
  await settle();
  srv.wechat = { ...srv.wechat, authorization: { active: false, remaining_ms: 0 } };
  await page.advance(5_000);
  assert.equal(seen(one(body(), '.ap-open')), R.OPEN_CHAT + R.OPEN_OFF + '授权 10 分钟', 'the zero-time read: over');
  // From now on 微信's reads do not come back, so whatever is shown next was painted from the held answer.
  srv.on.set('GET /xbot-api/apps/wechat', () => new Promise(() => {}));
  gate.release();
  await settle();
  assert.equal(all(body(), '.ap-clock').length, 0, 'the list read asked for before it is older evidence: no countdown again');
  assert.equal(seen(one(body(), '.ap-open')), R.OPEN_CHAT + R.OPEN_OFF + '授权 10 分钟');
  page.doc.activeElement.key('Escape');
  assert.equal(seen(row('wechat')), '微信已打开');
});

test('review r2 (1): an older read\'s failure never turns a newer good answer into unknown — the held list read fails after the zero-time read answered', async () => {
  const gate = hold();
  const { page, srv, body } = await opened(heldSecondList(gate, () => { throw fail(502); }));
  (page.doc.querySelector('.ap-row[data-app="wechat"]') as El).click();
  await settle();
  srv.wechat = { ...srv.wechat, authorization: { active: false, remaining_ms: 0 } };
  await page.advance(5_000);
  gate.release();
  await settle();
  assert.ok(!seen(one(body(), '.ap-open')).includes(R.OPEN_UNKNOWN), 'not 「没能读到…」: the newer read answered');
  assert.equal(seen(one(body(), '.ap-open')), R.OPEN_CHAT + R.OPEN_OFF + '授权 10 分钟');
});

test('review r2 (1): a detail read of 微信 older than a list read never paints over it — the zero-time read held while the list says 微信 was closed', async () => {
  const zero = hold(), xGate = hold();
  const { page, srv, row, body } = await opened((s) => {
    on(5_000)(s);
    s.add('custom:x', 'X', { type: 'program', program: 'node', args: [], secrets: [] });
    s.on.set('GET /xbot-api/apps/custom%3Ax', () => xGate.promise.then(() => { s.custom = s.custom.filter((x: Any) => x.id !== 'custom:x'); throw fail(404, '没有这个应用'); }));
  });
  row('wechat').click();
  await settle();
  // The zero-time read is asked for while 微信 is on, and held.
  srv.on.set('GET /xbot-api/apps/wechat', (c: Call) => { const answer = srv.fallback(c); return zero.promise.then(() => answer); });
  srv.wechat = { ...srv.wechat, authorization: { active: false, remaining_ms: 0 } };
  await page.advance(5_000);
  assert.equal(srv.sent('GET', /\/wechat$/).length, 1);
  // Then 微信 is closed elsewhere, and a list read asked for after it says so.
  srv.wechat = { ...srv.wechat, state: 'off', authorization: undefined };
  xGate.release();
  await settle();
  assert.equal(seen(one(body(), '.ap-state')), '未打开', 'the list read, asked for later: closed');
  zero.release();
  await settle();
  assert.equal(seen(one(body(), '.ap-state')), '未打开', 'the zero-time read asked for before it is older evidence');
});

test('review r2 (1): a read that overlapped a write gives way to it — a list read asked for while 关闭 is on its way, answered first, does not outrank 关闭\'s answer', async () => {
  const xGate = hold(), off = hold();
  const { srv, row, body } = await opened((s) => {
    on()(s);
    s.add('custom:x', 'X', { type: 'program', program: 'node', args: [], secrets: [] });
    s.on.set('GET /xbot-api/apps/custom%3Ax', () => xGate.promise.then(() => { s.custom = s.custom.filter((x: Any) => x.id !== 'custom:x'); throw fail(404, '没有这个应用'); }));
    s.on.set('POST /xbot-api/apps/wechat/disconnect', (c: Call) => off.promise.then(() => s.fallback(c)));
  });
  row('wechat').click();
  await settle();
  buttonOf(body(), '关闭').click();
  await settle();
  // Asked for after 关闭 was sent, answered before 关闭 took effect: 微信 still on.
  xGate.release();
  await settle();
  off.release();
  await settle();
  assert.equal(srv.sent('GET', /^\/xbot-api\/apps$/).length, 2);
  assert.equal(seen(one(body(), '.ap-state')), '未打开', '关闭\'s answer is what is shown');
});

test('review r2 (3): a list read that finds a custom app changed repaints its open page at once — not 已连接, not the old tools', async () => {
  const yGate = hold();
  const { srv, row, body } = await opened((s) => {
    s.add('custom:a', 'A', { type: 'program', program: 'node', args: ['a.js'], secrets: ['K'] });
    s.add('custom:y', 'Y', { type: 'program', program: 'node', args: [], secrets: [] });
    s.on.set('GET /xbot-api/apps/custom%3Ay', () => yGate.promise.then(() => { s.custom = s.custom.filter((x: Any) => x.id !== 'custom:y'); throw fail(404, '没有这个应用'); }));
  });
  row('custom:a').click();
  await settle();
  assert.equal(seen(one(body(), '.ap-state')), '已连接');
  assert.equal(all(body(), '.ap-tool').length, 1);
  srv.custom[0].source = { type: 'program', program: 'missing-new-program', args: [], secrets: ['OTHER'] };
  yGate.release();
  await settle();
  assert.equal(seen(one(body(), '.ap-state')), '未检查', 'the page open on it, at once');
  assert.equal(all(body(), '.ap-tool').length, 0, 'no tools from the old program');
  assert.equal(seen(one(body(), '.ap-cmd')), 'missing-new-program');
  assert.equal(srv.sent('GET', /custom%3Aa$/).length, 1, 'and no new check of its own');
});

test('review r2 (3): a check on its way for the old configuration loses its claim when the list finds it changed — its late success puts nothing back', async () => {
  const aGate = hold(), yGate = hold();
  const { srv, row, body, voice } = await opened((s) => {
    s.deaf = true; // the check given up on still answers, late, as an engine may
    s.add('custom:a', 'A', { type: 'program', program: 'node', args: ['a.js'], secrets: ['K'] });
    s.add('custom:y', 'Y', { type: 'program', program: 'node', args: [], secrets: [] });
    s.on.set('GET /xbot-api/apps/custom%3Aa', (c: Call) => { const answer = s.fallback(c); return aGate.promise.then(() => answer); });
    s.on.set('GET /xbot-api/apps/custom%3Ay', () => yGate.promise.then(() => { s.custom = s.custom.filter((x: Any) => x.id !== 'custom:y'); throw fail(404, '没有这个应用'); }));
  });
  assert.equal(seen(one(row('custom:a'), '.ap-st-word')), '正在检查…');
  srv.custom[0].source = { type: 'program', program: 'missing-new-program', args: [], secrets: ['OTHER'] };
  yGate.release();
  await settle();
  assert.equal(seen(one(row('custom:a'), '.ap-st-word')), '未检查', 'the check on its way was about something no longer there');
  aGate.release();
  await settle();
  assert.equal(seen(one(row('custom:a'), '.ap-st-word')), '未检查', 'its late success is not put back');
  row('custom:a').click();
  await settle();
  assert.equal(all(body(), '.ap-tool').length, 0);
  assert.equal(seen(one(body(), '.ap-cmd')), 'missing-new-program', 'not the old program either');
  assert.equal(srv.sent('GET', /custom%3Aa$/).length, 1, 'no new check of its own');
  assert.equal(voice(), '「A」没能检查。', 'the opening round still ends (y went, a was given up on), and is said once');
  // 再检查 on its way when the change is found: the same.
  const reGate = hold(), zGate = hold();
  const second = await opened((s) => {
    s.deaf = true;
    s.add('custom:a', 'A', { type: 'program', program: 'node', args: ['a.js'], secrets: ['K'] });
    s.add('custom:z', 'Z', { type: 'program', program: 'node', args: [], secrets: [] });
    s.on.set('GET /xbot-api/apps/custom%3Az', () => zGate.promise.then(() => { s.custom = s.custom.filter((x: Any) => x.id !== 'custom:z'); throw fail(404, '没有这个应用'); }));
  });
  second.row('custom:a').click();
  await settle();
  second.srv.on.set('GET /xbot-api/apps/custom%3Aa', (c: Call) => { const answer = second.srv.fallback(c); return reGate.promise.then(() => answer); });
  buttonOf(second.body(), '再检查').click();
  await settle();
  assert.equal(seen(one(second.body(), '.ap-state')), '正在检查…');
  second.srv.custom[0].source = { type: 'program', program: 'missing-new-program', args: [], secrets: ['OTHER'] };
  zGate.release();
  await settle();
  assert.equal(seen(one(second.body(), '.ap-state')), '未检查');
  reGate.release();
  await settle();
  assert.equal(seen(one(second.body(), '.ap-state')), '未检查', 'its late success is not put back');
  assert.equal(all(second.body(), '.ap-tool').length, 0);
  assert.ok(shown(buttonOf(second.body(), '再检查')) && !buttonOf(second.body(), '再检查').disabled, 'and 再检查 can be pressed again');
});

// ---------------------------------------------------------------- against the real adapter
// The dialog over the production router and the adapter (server/xbot/apps.ts, server/native/apps.ts) on the
// scripted engine of tests/apps-fixture.ts, through real HTTP: what it sends is what the adapter accepts,
// and what it shows is what the adapter answered.
test('against the real adapter: 微信 opened and authorized (the countdown from its answer) and revoked; a program added with a secret, connected, its tools shown, removed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-apps-dialog-')), native = new NativeFixture();
  const runtime = createApp({ native, dataFile: join(dir, 'presentation.json') });
  const app = express();
  app.use(express.json());
  app.use('/xbot-api', createXbotAppsRouter(runtime.bridge, new BotApps(native, runtime.store, 'darwin')));
  app.use((error: Any, _req: Any, res: Any, _next: Any) => res.status(error.status ?? (error.issues ? 400 : 500)).json({ error: error.issues ? error.issues.map((i: Any) => `${i.path.join('.')}: ${i.message}`).join('；') : error.message, ...(error.code ? { code: error.code } : {}) }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await runtime.close(); await new Promise<void>((r) => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });
  const address = server.address() as Any;
  // The shell's api(): the server's sentence and code on an error, a plain sentence when nothing answers.
  const api = async (path: string, opt: Any = {}) => {
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: opt.method || 'GET', headers: opt.body ? { 'Content-Type': 'application/json' } : {}, body: opt.body ? JSON.stringify(opt.body) : undefined, signal: opt.signal })
      .catch(() => { throw new Error('连不上 clowder-bot'); });
    const data: Any = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'request failed'), { status: res.status }, data.code ? { code: data.code } : {});
    return data;
  };
  const page = load();
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(ok(), what);
  };
  page.window.ClowderApps.init({ api, icon: icon(page.doc), now: page.now });
  page.window.ClowderApps.open({});
  const body = () => page.doc.querySelector('.ap-body') as El;
  const row = (id: string) => page.doc.querySelector(`.ap-row[data-app="${id}"]`) as El;
  await until(() => !!row('wechat'), 'the list is read');
  assert.equal(seen(row('wechat')), '微信未打开');
  row('wechat').click();
  // An off 微信 carries the plugin's own words: in 说明, one click away before 打开.
  buttonOf(body(), '说明').click();
  assert.match(seen(one(body(), '.ap-source')), /^插件原文 · 0\.1\.0-alpha\.7不会保存截图。/);
  buttonOf(body(), '打开').click();
  await until(() => seen(one(body(), '.ap-state')) === '已打开', '微信 is on');
  assert.equal(seen(one(body(), '.ap-by-name')), R.BY_NAME + R.BY_NAME_ON);
  buttonOf(body(), '授权 10 分钟').click();
  await until(() => all(body(), '.ap-clock').length === 1, 'authorized');
  // The engine's clock is not this page's (the test's clock is fixed): the remaining time it answered counts.
  assert.match(seen(one(body(), '.ap-clock')), /^(10:00|9:59)$/);
  assert.equal(native.apps.plugin!.live, 'running');
  buttonOf(body(), '撤销').click();
  await until(() => all(body(), '.ap-authorize').length === 1, 'revoked');
  assert.equal(native.apps.plugin!.live, 'running', '撤销 left 微信 on (reading by name stays until 关闭)');
  // The plugin's status cannot be read: the adapter leaves `authorization` out, and the page says unknown — then a fresh read.
  native.apps.statusFails = true;
  page.window.ClowderApps.close();
  page.window.ClowderApps.open({});
  await until(() => !!row('wechat'), 'the list is read again');
  assert.equal(seen(row('wechat')), '微信已打开');
  row('wechat').click();
  assert.deepEqual(all(body(), '.ap-open').map((n) => seen(n)), [R.OPEN_CHAT + R.OPEN_UNKNOWN + '再看一次撤销']);
  native.apps.statusFails = false;
  buttonOf(body(), '再看一次').click();
  await until(() => all(body(), '.ap-authorize').length === 1, 'read again: not authorized, as the plugin answered');
  // A program, with one secret.
  (page.doc.activeElement as El).key('Escape');
  one(body(), '.ap-row-add').click();
  const form = one(body(), 'form');
  const [nameIn, programIn] = all(form, 'input') as Any[];
  nameIn.value = 'Probe'; programIn.value = 'node';
  (one(form, 'textarea') as Any).value = 'probe.mjs';
  buttonOf(form, '添加环境变量').click();
  const secret = one(form, '.ap-secret');
  (one(secret, '.ap-secret-name') as Any).value = 'PROBE_TOKEN';
  (one(secret, '.ap-secret-in') as Any).value = 'shh';
  buttonOf(form, '添加').click();
  await until(() => seen(page.doc.querySelector('.ap-title')) === 'Probe', 'its page');
  assert.equal(seen(one(body(), '.ap-state')), '已连接');
  assert.equal(seen(one(body(), '.ap-note')), '加好了。');
  assert.deepEqual(all(body(), '.ap-tool-name').map((n) => seen(n)), ['app_probe']);
  assert.deepEqual(all(body(), '.ap-names code').map((n) => seen(n)), ['PROBE_TOKEN']);
  // The adapter gives every app an id of its own: the name's letters and a code (docs/apps-api.md).
  const row2 = native.apps.rows.find((r) => /^probe-[0-9a-f]{8}$/.test(r.id))!;
  assert.deepEqual([row2.mcpServer.command, row2.mcpServer.args, row2.mcpServer.env], ['node', ['probe.mjs'], { PROBE_TOKEN: 'shh' }]);
  buttonOf(body(), '移除').click();
  buttonOf(page.doc.querySelector('.ap-confirm') as El, '移除').click();
  await until(() => seen(page.doc.querySelector('.ap-title')) === '应用', 'back on the list');
  assert.equal(row('custom:' + row2.id), null);
  assert.equal(native.apps.rows.some((r) => r.id === row2.id), false);
  page.window.ClowderApps.close();
});

// ---------------------------------------------------------------- the page and the shell
test('the shell: 应用 opens the dialog from the full sidebar and the rail (one button), with menus and other dialogs closed first; the toast is gone', () => {
  const app = read('client/public/app.js'), html = read('client/index.html');
  assert.match(html, /<button id="side-apps" class="side-apps" type="button" aria-haspopup="dialog" aria-label="应用" data-tip="应用" data-tip-placement="right" data-tip-only="rail"><span class="side-apps-label">应用<\/span><\/button>/);
  assert.match(app, /\$\("side-apps"\)\.addEventListener\("click", \(\) => openApps\(\$\("side-apps"\)\)\);/);
  assert.doesNotMatch(app, /应用还没有开放/);
  const fn = /\n {2}function openApps\(opener\) \{\n([\s\S]*?)\n {2}\}\n/.exec(app)![1]!;
  assert.match(fn, /closePops\(\);\n\s+hideTip\(\);\n\s+if \(!modal\.hidden\) closeModal\(\);\n\s+if \(quick\) quick\.close\(\);\n\s+apps\.open\(\{ opener: opener && opener\.isConnected \? opener : document\.activeElement \}\);/);
  assert.match(app, /const apps = window\.ClowderApps;/);
  assert.match(app, /apps\.init\(\{ api, icon \}\);/);
  // The shell sends nothing to /xbot-api/apps itself; the original XBot store stays unloaded and byte-identical.
  assert.doesNotMatch(app, /\/xbot-api\/apps|XBotApps/);
  assert.doesNotMatch(html, /\/apps\.(js|css)"/);
  const manifest = JSON.parse(read('docs/xbot-frontend-manifest.json'));
  for (const f of ['apps.js', 'apps.css']) {
    const entry = manifest.files.find((e: Any) => e.file === f);
    assert.ok(entry, f + ' is still recorded');
  }
});

test('the page loads the 应用 pieces in place: the rules before the dialog, both before app.js; the stylesheet after chat-panel.css, before chat-live.css; all recorded in the manifest', () => {
  const html = read('client/index.html');
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"><\/script>/g)].map((m) => m[1]!);
  const styles = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)">/g)].map((m) => m[1]!);
  assert.equal(scripts.indexOf('apps-dialog.js'), scripts.indexOf('apps-dialog-rules.js') + 1);
  assert.ok(scripts.indexOf('apps-dialog.js') < scripts.indexOf('app.js'));
  assert.deepEqual(styles.slice(-3), ['chat-panel.css', 'apps-dialog.css', 'chat-live.css']);
  const manifest = JSON.parse(read('docs/xbot-frontend-manifest.json'));
  for (const f of ['apps-dialog-rules.js', 'apps-dialog.js', 'apps-dialog.css']) assert.ok(manifest.extensions.some((e: Any) => e.target === 'client/public/' + f), f + ' is registered');
});

test('apps-dialog.css: tokens only, the original modal card, a sheet at 560px and below with 44px targets, focus visible, nothing moves under reduced motion', () => {
  const css = read('client/public/apps-dialog.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, 'no colours of its own');
  assert.doesNotMatch(css, /font-family:\s*["']|@font-face|@keyframes|@import/, 'no new font or keyframes');
  assert.doesNotMatch(css, /var\(--(?:x-primary|x-primary-hover|primary|primary-hover|send)\)/, 'no fill in the primary of its own: .primary draws its buttons');
  const phone = /@media \(max-width: 560px\) \{([\s\S]*?)\n\}/.exec(css)![1]!;
  assert.match(phone, /\.ap-modal \{ place-items: end stretch; padding: 0;/);
  assert.match(phone, /border-radius: 20px 20px 0 0;/);
  for (const sel of ['.ap-back, .ap-x', '.ap-peek, .ap-drop']) assert.ok(phone.includes(sel + ' { width: 44px; height: 44px;'), sel);
  assert.match(phone, /\.ap-swap, \.ap-add-secret, \.ap-detail-btn, \.ap-more, \.ap-remove, \.ap-twin \{ min-height: 44px; \}/);
  for (const sel of ['.ap-row', '.ap-kind', '.ap-tool-btn', '.ap-name']) assert.match(css, new RegExp(sel.replace('.', '\\.') + ':focus-visible \\{ outline: 2px solid var\\(--accent\\)'), sel);
  const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)![1]!;
  assert.match(reduced, /\.ap-view, \.ap-wait-text \{ animation: none; \}/);
  assert.match(reduced, /transition: none;/);
  // The card's height is eased by the script only when motion is allowed.
  const js = read('client/public/apps-dialog.js');
  assert.match(js, /!media\("\(prefers-reduced-motion: reduce\)"\)/);
});
