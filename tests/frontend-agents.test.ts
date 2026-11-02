import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

// Frontend checks for local Agent access. The page scripts are classic
// browser scripts; they run here in a VM with a tiny DOM, the way
// cat-avatars.test.ts loads its renderer.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));

type Text = { textContent: string; parent: El | null };
type Root = { body: El | null; focused: El | null };
class El {
  children: Array<El | Text> = []; parent: El | null = null; attrs: Record<string, string> = {};
  className = ''; type = ''; id = ''; title = ''; href = ''; target = ''; rel = '';
  disabled = false; hidden = false; tabIndex = 0; open = false;
  onclick: (() => unknown) | null = null; onkeydown: ((ev: unknown) => unknown) | null = null;
  constructor(readonly tag: string, readonly root: Root) {}
  get classList() {
    const names = () => new Set(this.className.split(' ').filter(Boolean));
    return {
      toggle: (name: string, on?: boolean) => { const set = names(); if (on ?? !set.has(name)) set.add(name); else set.delete(name); this.className = [...set].join(' '); },
      contains: (name: string) => names().has(name),
    };
  }
  append(...nodes: Array<El | Text | string>) {
    for (const item of nodes) {
      const child: El | Text = typeof item === 'string' ? { textContent: item, parent: null } : item;
      if (child.parent) child.parent.children = child.parent.children.filter(c => c !== child);
      child.parent = this; this.children.push(child);
    }
  }
  replaceChildren(...nodes: Array<El | Text | string>) { for (const c of this.children) c.parent = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; } }
  get textContent(): string { return this.children.map(c => c.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); if (value) this.append(String(value)); }
  setAttribute(key: string, value: unknown) { this.attrs[key] = String(value); }
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  addEventListener() {}
  get isConnected(): boolean { for (let n: El | null = this; n; n = n.parent) if (n === this.root.body) return true; return false; }
  focus() { this.root.focused = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  getBoundingClientRect() { return { left: 0, right: 0, top: 0, bottom: 0 }; }
}
const all = (root: El): El[] => root.children.flatMap(c => c instanceof El ? [c, ...all(c)] : []);
const byText = (root: El, text: string) => all(root).find(n => n.tag === 'button' && n.textContent === text);
const radios = (root: El) => all(root).filter(n => n.getAttribute('role') === 'radio');
const named = (root: El, cls: string) => all(root).filter(n => n.className.split(' ').includes(cls));

function browser(script = 'client/public/agents.js') {
  const root: Root = { body: null, focused: null };
  const body = new El('body', root); root.body = body;
  const document = { body, createElement: (tag: string) => new El(tag, root) };
  const window: any = {};
  vm.runInNewContext(read(script), { window, document });
  return { agents: window.XBotAgents, window, document, body };
}
type Call = { path: string; method: string; body?: unknown };
function fakeApi(inventory: unknown, write?: (body: unknown) => unknown) {
  const calls: Call[] = [];
  const api = async (path: string, opt: { method?: string; body?: unknown } = {}) => {
    calls.push({ path, method: opt.method || 'GET', ...(opt.body === undefined ? {} : { body: plain(opt.body) }) });
    if (path.startsWith('/xbot-api/agents')) return plain(inventory);
    if (write) return write(opt.body);
    throw Object.assign(new Error('unexpected ' + path), { status: 404 });
  };
  return { api, calls };
}

const agent = (over: Record<string, unknown> = {}) => ({
  id: 'codex', label: 'Codex', clientId: 'openai', installed: true, supported: true, selectable: true, unavailableReason: null,
  command: 'codex', transport: 'cli', configuredModel: 'gpt-5.5', configuredEffort: 'high',
  readiness: { status: 'configured', checkedAt: 1761900000000 }, bots: [], activity: { state: 'idle', active: 0, queued: 0, scope: 'bot_threads' }, ...over,
});
const codex = agent();
const claude = agent({ id: 'claude', label: 'Claude Code', clientId: 'anthropic', command: 'claude', configuredModel: null, configuredEffort: null, readiness: { status: 'unknown', checkedAt: null } });
const kimi = agent({ id: 'kimi', label: 'Kimi', clientId: 'kimi', command: 'kimi', selectable: false, unavailableReason: '请先在本机 Agent 中完成登录', readiness: { status: 'login_required', checkedAt: 1761900000000, loginCommand: 'kimi login' } });
const inventory = { checkedAt: 1761900000000, agents: [claude, codex, kimi] };
const local = (over: Record<string, unknown> = {}) => ({ id: 'codex', label: 'Codex', configurationSource: 'native_tool', modelOverride: null, configuredModel: 'gpt-5.5', ...over });
const managed = { id: null, label: 'Clowder AI 托管接入', configurationSource: 'managed_account', modelOverride: 'gpt-4o', configuredModel: null };

test('readiness is login or config evidence only, and an unrecognised status claims nothing', () => {
  const { model } = browser().agents;
  for (const status of ['configured', 'login_required', 'unknown', 'not_installed']) {
    assert.doesNotMatch(model.readiness(agent({ readiness: { status } })).text, /运行|已连接|在线|可用/);
  }
  assert.match(model.readiness(codex).text, /登录或配置记录/);
  assert.equal(model.readiness(agent({ readiness: { status: 'ready' } })).status, 'unknown');
  assert.equal(model.readiness(agent({ readiness: undefined })).status, 'unknown');
});

test('only installed, supported Agents without a login gap can be chosen; unknown readiness stays choosable', () => {
  const { model } = browser().agents;
  assert.equal(model.selectable(claude), true);
  assert.equal(model.selectable(kimi), false);
  assert.equal(model.selectable({ ...kimi, selectable: true }), false, 'login_required is refused even if the server says otherwise');
  assert.equal(model.selectable(agent({ installed: false, readiness: { status: 'not_installed', checkedAt: null } })), false);
  assert.equal(model.selectable(agent({ supported: false, selectable: false })), false);
  assert.equal(model.unavailable(kimi), '请先在本机 Agent 中完成登录');
  assert.equal(model.unavailable(codex), '');
  assert.equal(model.preferred([claude, codex, kimi]).id, 'codex');
  assert.equal(model.preferred([kimi, claude]).id, 'claude');
  assert.equal(model.preferred([kimi]), null);
});

test('activity covers Bot threads only and never reads unknown as idle', () => {
  const { model } = browser().agents;
  assert.equal(model.activity(agent({ activity: { state: 'unknown', active: null, queued: null, scope: 'bot_threads' } })), '状态未知');
  assert.equal(model.activity(agent({ activity: undefined })), '状态未知');
  assert.equal(model.activity(codex), '空闲');
  assert.equal(model.activity(agent({ activity: { state: 'idle', active: 0, queued: 3, scope: 'bot_threads' } })), '3 个排队');
  assert.equal(model.activity(agent({ activity: { state: 'running', active: 2, queued: 1, scope: 'bot_threads' } })), '2 个执行中 · 1 个排队');
});

test('a managed account binding stays read-only and is never shown as a local Agent', () => {
  const { model } = browser().agents;
  const legacy = model.binding(managed);
  assert.equal(legacy.local, false);
  assert.equal(legacy.title, 'Clowder AI 托管接入');
  assert.match(legacy.detail, /只读保留/);
  assert.deepEqual(plain(model.binding(local())), { local: true, id: 'codex', title: 'Codex', detail: '沿用本机默认 · gpt-5.5', override: '' });
  assert.match(model.binding(local({ modelOverride: 'gpt-4o' })).detail, /Bot 单独指定 gpt-4o/);
  assert.equal(model.binding(undefined).local, false);
});

test('switching explains its effect; the current Agent is a change only when it clears an override', () => {
  const { model } = browser().agents;
  const view = model.binding(local());
  assert.equal(model.unchanged(view, codex), true);
  assert.equal(model.unchanged(view, claude), false);
  assert.equal(model.unchanged(model.binding(local({ modelOverride: 'gpt-4o' })), codex), false);
  const note = model.impact('ada', claude, view);
  assert.match(note, /「ada」改由 Claude Code 执行/);
  assert.match(note, /清除这个 Bot 单独设置的账号、模型和推理强度/);
  assert.match(note, /聊天记录会保留/);
  assert.match(note, /还没确认 Claude Code 已登录/);
  assert.doesNotMatch(model.impact('ada', codex, model.binding(managed)), /还没确认/);
  assert.match(model.impact('ada', codex, model.binding(local({ modelOverride: 'gpt-4o' }))), /清除「ada」单独指定的模型 gpt-4o/);
});

test('a 409 keeps the server\'s reason and is never guessed to be work in flight', async () => {
  const { model } = browser().agents;
  const busy = '请先完成或停止这个 Bot 的任务，再更换 Agent';
  const revision = '成员已在其他页面修改。草稿已保留，请重新读取后核对再保存。';
  assert.equal(model.bindError({ status: 409, message: busy }, 'ada'), busy);
  assert.equal(model.bindError({ status: 409, message: revision }, 'ada'), revision);
  const unknown = model.bindError({ status: 409, message: 'Conflict' }, 'ada');
  assert.match(unknown, /「ada」的配置刚有变化/);
  assert.doesNotMatch(unknown, /任务|执行|排队/);
  assert.equal(model.bindError({ status: 422, message: '请先在本机 Agent 中完成登录' }, 'ada'), '请先在本机 Agent 中完成登录');
  assert.equal(model.bindError(new Error('request failed'), 'ada'), '没能更换 Agent，请稍后再试。');
  const { api, calls } = fakeApi(inventory);
  await model.inventory(api, true);
  await model.inventory(api);
  assert.deepEqual(calls.map(c => c.path), ['/xbot-api/agents?refresh=1', '/xbot-api/agents']);
});

test('changing a Bot\'s Agent waits for an explicit confirmation and sends only the runtime id', async () => {
  const { agents, body } = browser();
  const bound: unknown[] = [];
  const { api, calls } = fakeApi(inventory, () => ({ name: 'ada', agent: local({ id: 'claude', label: 'Claude Code', configuredModel: null }) }));
  await agents.open({ api, data: { name: 'ada', agent: local() }, manage() {}, onBound: (next: unknown) => { bound.push(plain(next)); } });
  const dialog = all(body).find(n => n.tag === 'dialog')!;
  assert.ok(dialog.open);
  const options = radios(dialog), use = byText(dialog, '改用此 Agent')!;
  assert.deepEqual(options.map(n => all(n).find(c => c.tag === 'strong')!.textContent), ['Claude Code', 'Codex', 'Kimi']);
  assert.equal(options[1].getAttribute('aria-checked'), 'true');
  assert.ok(options[2].disabled, 'an Agent that needs a login cannot be picked');
  assert.match(options[2].textContent, /请先在本机 Agent 中完成登录.*需要先登录/);
  assert.ok(use.disabled, 'keeping the current Agent is not a change');
  options[0].onclick!();
  assert.equal(options[0].getAttribute('aria-checked'), 'true');
  assert.ok(!use.disabled);
  assert.match(named(dialog, 'binding-note')[0].textContent, /清除这个 Bot 单独设置的账号、模型和推理强度/);
  assert.deepEqual(calls.map(c => c.method), ['GET'], 'reading and staging never write');
  await use.onclick!();
  assert.deepEqual(calls.slice(1), [{ path: '/xbot-api/bots/ada/agent', method: 'PUT', body: { runtimeId: 'claude' } }]);
  assert.equal(dialog.isConnected, false);
  assert.equal(bound.length, 1);
});

test('a switch refused while work is in flight keeps the dialog open and says why', async () => {
  const { agents, body } = browser();
  const { api, calls } = fakeApi(inventory, () => { throw Object.assign(new Error('请先完成或停止这个 Bot 的任务，再更换 Agent'), { status: 409 }); });
  await agents.open({ api, data: { name: 'ada', agent: managed }, manage() {}, busy: () => true });
  const dialog = all(body).find(n => n.tag === 'dialog')!;
  assert.match(named(dialog, 'binding-sub')[0].textContent, /当前 Clowder AI 托管接入（只读保留）/);
  assert.equal(radios(dialog).filter(r => r.getAttribute('aria-checked') === 'true').length, 0, 'a managed account is not preselected as a local Agent');
  radios(dialog)[1].onclick!();
  assert.match(named(dialog, 'binding-note')[0].textContent, /现在有任务在执行或排队/);
  const use = byText(dialog, '改用此 Agent')!;
  await use.onclick!();
  assert.equal(dialog.isConnected, true);
  assert.equal(named(dialog, 'bad')[0].textContent, '请先完成或停止这个 Bot 的任务，再更换 Agent');
  assert.ok(!use.disabled, 'the user can retry once the work is done');
  assert.equal(calls.filter(c => c.method === 'PUT').length, 1);
});

test('while a switch is saving, the staged choice cannot change and the saved one is reported', async () => {
  const { agents, body } = browser();
  let finish: (value: unknown) => void = () => {};
  const bound: unknown[] = [];
  const { api, calls } = fakeApi(inventory, () => new Promise(resolve => { finish = resolve; }));
  await agents.open({ api, data: { name: 'ada', agent: managed }, manage() {}, onBound: (next: unknown, picked: { id: string }) => { bound.push([plain(next), picked.id]); } });
  const dialog = all(body).find(n => n.tag === 'dialog')!;
  const [claudeRow, codexRow] = radios(dialog), use = byText(dialog, '改用此 Agent')!;
  claudeRow.onclick!();
  const saving = use.onclick!();
  await settle();
  codexRow.onclick!();
  assert.equal(claudeRow.getAttribute('aria-checked'), 'true');
  assert.equal(codexRow.getAttribute('aria-checked'), 'false');
  assert.ok(use.disabled, 'the confirm button stays off until the save settles');
  finish({ name: 'ada', agent: local({ id: 'claude', label: 'Claude Code' }) });
  await saving;
  assert.deepEqual(calls.filter(c => c.method === 'PUT').map(c => c.body), [{ runtimeId: 'claude' }]);
  assert.deepEqual(bound, [[local({ id: 'claude', label: 'Claude Code' }), 'claude']]);
});

test('a new Bot is offered only choosable Agents and defaults to one with login evidence', async () => {
  const { agents, body } = browser();
  const { api, calls } = fakeApi(inventory);
  const changes: string[] = [];
  const field = agents.field({ api, onChange: (id: string) => changes.push(id) });
  body.append(field.element);
  await settle();
  const rows = radios(field.element);
  assert.deepEqual(rows.map(r => named(r, 'ws-name')[0].textContent), ['Claude Code', 'Codex']);
  assert.equal(field.value(), 'codex');
  assert.deepEqual(changes, ['', 'codex']);
  assert.doesNotMatch(field.element.textContent, /还没确认/);
  rows[0].onclick!();
  assert.equal(field.value(), 'claude');
  assert.match(field.element.textContent, /另有 1 个 Agent 暂不能选用/);
  assert.match(field.element.textContent, /还没确认 Claude Code 已登录；如果没登录，第一次执行会失败/);
  assert.deepEqual(calls, [{ path: '/xbot-api/agents', method: 'GET' }]);
});

test('without a choosable Agent the new Bot form has nothing to submit and can re-check', async () => {
  const { agents, body } = browser();
  const unsupported = agent({ id: 'gemini', label: 'Gemini', supported: false, selectable: false, unavailableReason: '此 Agent 的接入方式尚未适配', readiness: { status: 'unknown', checkedAt: null } });
  const { api, calls } = fakeApi({ checkedAt: 1, agents: [kimi, unsupported] });
  const changes: string[] = [];
  const field = agents.field({ api, onChange: (id: string) => changes.push(id) });
  body.append(field.element);
  await settle();
  assert.equal(field.value(), '');
  assert.ok(changes.every(id => id === ''));
  assert.equal(radios(field.element).length, 0);
  await byText(field.element, '重新检测')!.onclick!();
  assert.equal(calls.at(-1)!.path, '/xbot-api/agents?refresh=1');
});

test('the settings pane reports login evidence and Bot-thread activity without overstating either', async () => {
  const { agents, document, body } = browser();
  const busy = agent({ bots: [{ id: 'bot-1', name: 'ada', configurationSource: 'native_tool' }], activity: { state: 'running', active: 1, queued: 2, scope: 'bot_threads' } });
  const unseen = { ...claude, bots: [{ id: 'bot-2', name: 'bob', configurationSource: 'native_tool' }], activity: { state: 'unknown', active: null, queued: null, scope: 'bot_threads' } };
  const { api, calls } = fakeApi({ checkedAt: 1761900000000, agents: [busy, unseen, kimi] });
  const host = document.createElement('div'); body.append(host);
  await agents.settings({ api, host });
  const rows = named(host, 'agent-row').map(r => r.textContent);
  assert.match(rows[0], /Codex.*已有登录或配置记录.*ada.*1 个执行中 · 2 个排队/);
  assert.match(rows[1], /Claude Code.*未确认登录状态.*bob.*状态未知/);
  assert.doesNotMatch(rows[1], /空闲/);
  assert.match(rows[2], /Kimi.*需要先登录.*kimi login/);
  assert.match(host.textContent, /不代表 Agent 已在运行/);
  assert.match(host.textContent, /只统计 clowder-bot 管理的会话/);
  await byText(host, '重新检测')!.onclick!();
  assert.deepEqual(calls.map(c => c.path), ['/xbot-api/agents', '/xbot-api/agents?refresh=1']);
});

function files(dir: string): string[] {
  return readdirSync(new URL('../' + dir, import.meta.url), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(dir + '/' + entry.name) : /\.(?:js|html)$/.test(entry.name) ? [dir + '/' + entry.name] : []);
}

test('the page no longer reaches the retired model store, key or binding routes', () => {
  const retired = /\/xbot-api\/(?:models|providers|setup)\b|\/binding(?:["'`?/]|$)|\bmodelCatalog\b|\bmodelHits\b|native-runtimes/m;
  const checked = files('client').filter(file => file !== 'client/public/runtime.js');
  assert.ok(checked.includes('client/public/app.js') && checked.includes('client/index.html'));
  for (const file of checked) assert.doesNotMatch(read(file), retired, file);
  const html = read('client/index.html');
  assert.doesNotMatch(html, /模型与供应商|id="setup"|API key/);
  assert.match(html, /data-set="agents"[^>]*>.*本地 Agent<\/span>/);
  assert.match(html, /data-spane="agents"/);
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(scripts.includes('/agents.js') && scripts.indexOf('/agents.js') < scripts.indexOf('/app.js'));
  assert.match(html, /<link rel="stylesheet" href="\/agents\.css">/);
});

for (const [script, module, route, title] of [
  ['client/public/image-gen.js', 'XBotImageGen', '/xbot-api/image-gen', '图片生成'],
  ['client/public/web-search.js', 'XBotWebSearch', '/xbot-api/web-search', '网页搜索'],
] as const) {
  test(`${title} is a read-only Agent note with no provider, key or switch path`, async () => {
    const source = read(script);
    assert.doesNotMatch(source, /method:\s*["']?(?:PUT|POST|PATCH|DELETE)|\/key\b|providers|role", "switch"|"tog"|模型与供应商/);
    for (const reply of [{ supported: false, reason: '能力由 Clowder AI 管理；运行面板可查看原生配置。' }, { supported: true, enabled: true, providers: [{ id: 'openai', name: 'OpenAI' }] }]) {
      const { window, document, body } = browser(script);
      let answer: (value: unknown) => void = () => {};
      const calls: string[] = [];
      let managed = 0;
      const host = document.createElement('div'); body.append(host);
      const mounted = window[module].mount({ api: (path: string, opt?: unknown) => { calls.push(path + (opt ? ' write' : '')); return new Promise(resolve => { answer = resolve; }); }, host, isCurrent: () => true, manage: () => { managed++; } });
      assert.match(host.textContent, /由执行 Bot 的本地 Agent 决定.*由本地 Agent 管理.*正在读取说明/, 'Agent wording from the first paint');
      answer(reply);
      await mounted;
      assert.deepEqual(calls, [route]);
      assert.equal(radios(host).length + all(host).filter(n => n.getAttribute('role') === 'switch').length, 0);
      assert.equal(reply.supported ? !host.textContent.includes('OpenAI') : host.textContent.includes('运行面板可查看原生配置'), true);
      byText(host, '查看本地 Agent')!.onclick!();
      assert.equal(managed, 1);
    }
    const { window, document, body } = browser(script);
    const host = document.createElement('div'); body.append(host);
    await window[module].mount({ api: async () => { throw new Error('offline'); }, host, isCurrent: () => true });
    assert.match(named(host, 'ws-error')[0].textContent, new RegExp(`没能读取${title}说明`));
    assert.ok(byText(host, '查看本地 Agent'), 'the way to Agent settings stays available on error');
  });
}

test('the runtime panel lists native accounts read-only and offers no key entry', () => {
  const html = read('client/public/runtime.html'), script = read('client/public/runtime.js');
  assert.doesNotMatch(html, /type="password"|account-form|API 密钥/);
  assert.doesNotMatch(script, /'\/api\/accounts[^']*',\s*'(?:POST|PATCH|PUT|DELETE)'/);
});

test('providers.js keeps only citations and hosted-search steps', () => {
  const window: any = {};
  vm.runInNewContext(read('client/public/providers.js'), { window, URL });
  assert.deepEqual(Object.keys(window.XBotProviders).sort(), ['citedText', 'decorate', 'progress']);
  assert.equal(window.XBotProviders.citedText('见此处', [{ citation: { url: 'https://example.com/a(b)', end: 2, title: '示例' } }]), '见此 [1](https://example.com/a%28b%29)处');
});
