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
  disabled = false; hidden = false; tabIndex = 0; open = false; value = '';
  onclick: (() => unknown) | null = null; onkeydown: ((ev: unknown) => unknown) | null = null; oninput: (() => unknown) | null = null;
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
  return { agents: window.XBotAgents, window, document, body, root };
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
// GET /xbot-api/bots/:name cat_config with the cat's own effort.
const ownEffort = { runtimeId: 'codex', breed: { mode: 'explicit', breedId: 'maine-coon' }, model: { mode: 'inherit' }, effort: { mode: 'explicit', value: 'high' }, portrait: { roleDescription: '审阅' } };

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
  assert.equal(legacy.legacy, true);
  assert.deepEqual(plain(model.binding(local())), { local: true, legacy: false, id: 'codex', title: 'Codex', detail: '沿用本机默认 · gpt-5.5', override: '', effort: '' });
  assert.match(model.binding(local({ modelOverride: 'gpt-4o' })).detail, /Bot 单独指定 gpt-4o/);
  // The cat's own effort comes from the cat_config copied at creation.
  assert.equal(model.binding(local({ modelOverride: 'gpt-4o' }), ownEffort).detail, 'Bot 单独指定 gpt-4o · 推理强度 high');
  assert.equal(model.binding(local(), { ...ownEffort, effort: { mode: 'inherit' } }).detail, '沿用本机默认 · gpt-5.5');
  assert.equal(model.binding(undefined).local, false);
  assert.equal(model.binding(undefined).legacy, false, 'an unread binding is not called an older carrier');
});

test('switching names only what it really clears; the current Agent is a change only when it clears something', () => {
  const { model } = browser().agents;
  const view = model.binding(local());
  assert.equal(model.unchanged(view, codex), true);
  assert.equal(model.unchanged(view, claude), false);
  assert.equal(model.unchanged(model.binding(local({ modelOverride: 'gpt-4o' })), codex), false);
  assert.equal(model.unchanged(model.binding(local(), ownEffort), codex), false, 're-choosing clears the cat\'s own effort');
  assert.equal(model.impact(view), '', 'nothing of the Bot\'s own to drop, nothing to say');
  assert.equal(model.impact(model.binding(local({ modelOverride: 'gpt-4o' }), ownEffort)), '确认后会清除单独指定的模型 gpt-4o、单独指定的推理强度 high。');
  assert.equal(model.impact(model.binding(managed)), '确认后会清除原有接入、单独指定的模型 gpt-4o。');
  assert.equal(model.impact(model.binding(undefined)), '');
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
  assert.equal(named(dialog, 'binding-note')[0].textContent, '', 'no standing guide text when nothing of the Bot\'s own is cleared');
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
  assert.equal(named(dialog, 'binding-note')[0].textContent, '确认后会清除原有接入、单独指定的模型 gpt-4o。有任务在执行或排队，完成或停止后才能更换。');
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

test('a cat with its own effort can re-choose its Agent to clear it, and the trigger shows the cleared state', async () => {
  const { agents, body } = browser();
  const bound: unknown[] = [];
  const { api, calls } = fakeApi(inventory, () => ({ name: 'ada', agent: local() }));
  const data: any = { name: 'ada', agent: local(), cat_config: ownEffort };
  const trigger = agents.trigger({ api, data, manage() {}, onBound: (next: unknown) => { bound.push(plain(next)); } });
  body.append(trigger);
  assert.match(trigger.textContent, /Bot 单独指定 推理强度 high/);
  await trigger.onclick!();
  const dialog = all(body).find(n => n.tag === 'dialog')!;
  const current = radios(dialog).find(r => r.getAttribute('aria-checked') === 'true')!;
  assert.equal(all(current).find(c => c.tag === 'strong')!.textContent, 'Codex');
  const use = byText(dialog, '改用此 Agent')!;
  assert.ok(!use.disabled, 'the cat\'s own effort makes re-choosing a real change');
  assert.equal(named(dialog, 'binding-note')[0].textContent, '确认后会清除单独指定的推理强度 high。');
  await use.onclick!();
  assert.deepEqual(calls.filter(c => c.method === 'PUT'), [{ path: '/xbot-api/bots/ada/agent', method: 'PUT', body: { runtimeId: 'codex' } }]);
  assert.equal(bound.length, 1);
  assert.deepEqual(plain(data.cat_config.effort), { mode: 'inherit' });
  assert.match(trigger.textContent, /沿用本机默认 · gpt-5\.5/);
});

// Static wiring of the official shell to the template module (cat-templates.js
// owns its own behaviour and tests): entry points, script order and retired paths.
test('the shell wires 模板 and 新建猫猫 to the template module and retires the persona-card binding', () => {
  const html = read('client/index.html'), app = read('client/public/app.js');
  assert.match(html, /data-set="persona"[^>]*>.*<span>模板<\/span><\/button>/);
  assert.doesNotMatch(html, /人设卡|新建 Bot/);
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  const at = (src: string) => scripts.indexOf(src);
  assert.ok(at('/cat-avatars.js') >= 0 && at('/cat-avatars.js') < at('/cat-template-rules.js'), 'portraits load before the template module');
  assert.ok(at('/cat-template-rules.js') < at('/cat-templates.js') && at('/cat-templates.js') < at('/app.js'));
  assert.equal(at('/persona-cards.js'), -1, 'the old persona-card pane no longer loads');
  const styles = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]);
  assert.ok(styles.indexOf('/cafe-theme.css') < styles.indexOf('/cat-templates.css'), 'template styles sit after the café overlay');
  assert.ok(styles.includes('/persona-cards.css') && styles.includes('/skills.css'), 'the shared list and editor styles the module reuses stay loaded');
  // 设置 · 模板 mounts the module with the settings bar level, and every exit tears it down.
  assert.match(app, /ClowderCatTemplates\.mount\(\{api, host:\$\("settings-persona"\), isCurrent:[^}]+onLevel:/);
  assert.equal(app.match(/window\.ClowderCatTemplates\?\.teardown\(\)/g)!.length, 3);
  assert.doesNotMatch(app, /XBotPersonaCards|persona-cards?["'/]|人设卡/);
  // 新建猫猫 opens the module's single create layer; the shell sends no create request of its own.
  assert.match(app, /item\("plus", "新建猫猫", \(\) => openNewBot\(anchor\)\)/);
  assert.match(app, /ClowderCatTemplates\.openCreate\(\{[\s\S]*?onCreated: async \(created\) => \{\s*await refreshLists\(\);\s*await selectBot\(created\.name\);/);
  assert.match(app, /manageAgents: \(\) => openSettings\("agents"\)/);
  assert.doesNotMatch(app, /["']\/xbot-api\/bots["']\s*,\s*\{\s*method:\s*["']POST/);
  assert.doesNotMatch(app, /新建 Bot|XBotAgents\.field/);
  assert.equal(browser().agents.field, undefined);
  // The profile keeps direct 职责 editing; the JSON pair is the cat's 资料.
  assert.match(app, /"导出资料"/);
  assert.match(app, /"导入资料"/);
  assert.doesNotMatch(app, /导出模板|导入模板/);
  // The drawer shows the copied cat_config without provenance, and its breed
  // table lists only IDs with a name, so a synthetic breed ID is never shown.
  assert.match(app, /data\.cat_config/);
  assert.doesNotMatch(app, /source_template/);
  assert.match(app, /const breeds = \[\.\.\.ids\]\.map\([^\n]*\|\| ""[^\n]*\)\.filter\(\(b\) => b\.name\);/);
  // The phone settings home is the list alone, without a guide line.
  assert.doesNotMatch(html, /setnavlead|点开一项继续/);
});

// Settings · 本地 Agent: a list grouped by installation, one line per Agent,
// and one Agent per detail page. Same inventory shape as GET /xbot-api/agents.
const busyCodex = agent({ bots: [{ id: 'bot-1', name: 'ada', configurationSource: 'native_tool' }], activity: { state: 'running', active: 1, queued: 2, scope: 'bot_threads' } });
const unseenClaude = { ...claude, bots: [{ id: 'bot-2', name: 'bob', configurationSource: 'native_tool' }], activity: { state: 'unknown', active: null, queued: null, scope: 'bot_threads' } };
const kimiLogin = { ...kimi, unavailableReason: '请先在本机 Agent 中完成登录' };
const gemini = agent({ id: 'gemini', label: 'Gemini', clientId: 'google', command: 'gemini', transport: 'acp', supported: false, selectable: false, unavailableReason: '此 Agent 的接入方式尚未适配', configuredModel: null, configuredEffort: null, readiness: { status: 'unknown', checkedAt: null } });
// Not installed: native discovery still reports idle 0/0 activity for it.
const pi = agent({ id: 'pi', label: 'Pi', clientId: 'acp', installed: false, supported: false, selectable: false, unavailableReason: '本机尚未检测到这个 Agent', command: null, transport: 'acp', configuredModel: null, configuredEffort: null, readiness: { status: 'not_installed', checkedAt: 1761900000000 } });
const listed = { checkedAt: 1761900000000, agents: [busyCodex, unseenClaude, kimiLogin, gemini, pi] };

async function settingsPane(inventory: unknown = listed, api?: (path: string) => Promise<unknown>) {
  const page = browser();
  const fake = fakeApi(inventory);
  const levels: Array<{ title: string; backLabel: string; back: () => void } | null> = [];
  const host = page.document.createElement('div'); page.body.append(host);
  const mounted = page.agents.settings({ api: api || fake.api, host, onLevel: (level: any) => { levels.push(level); } });
  return { ...page, host, levels, calls: fake.calls, mounted };
}
const rowsOf = (host: El) => named(host, 'agent-item');
const hintOf = (row: El) => named(row, 'hint')[0].textContent;
const nameOf = (row: El) => all(row).find(n => n.tag === 'b')!.textContent;
const visible = (node: El): boolean => { for (let n: El | null = node; n; n = n.parent) if (n.hidden) return false; return true; };

test('settings lists local Agents by installation, one real status line each and no guide text', async () => {
  const { host, levels, calls, mounted } = await settingsPane();
  await mounted;
  assert.deepEqual(named(host, 'setsec').map(s => s.children[0].textContent), ['已安装', '未安装']);
  const rows = rowsOf(host);
  assert.deepEqual(rows.map(nameOf), ['Codex', 'Claude Code', 'Kimi', 'Gemini', 'Pi']);
  assert.deepEqual(rows.map(hintOf), [
    '已有配置记录 · 1 个 Bot · 1 个执行中 · 2 个排队',
    '未确认登录 · 1 个 Bot · 会话状态未知',
    '需要先登录',
    '暂未适配',
    '未检测到',
  ]);
  assert.ok(rows.every(r => r.tag === 'button' && named(r, 'skchev').length === 1), 'each row opens a detail page');
  assert.deepEqual(rows.map(r => named(r, 'bico')[0].className), ['bico agent-ico oa', 'bico agent-ico cl', 'bico agent-ico agent-kimi', 'bico agent-ico ag', 'bico agent-ico ag']);
  // Installed, login evidence and Bot-session activity stay three facts; none reads as connected or running.
  assert.doesNotMatch(host.textContent, /已连接|运行中|在线|空闲/);
  // The user removed the first-screen lead and footnotes.
  assert.equal(named(host, 'setlead').length + named(host, 'setfoot').length, 0);
  assert.doesNotMatch(host.textContent, /Bot 交给这台电脑|沿用 Agent 自己的配置|不代表|只统计/);
  assert.equal(all(host).find(n => n.tag === 'h2')!.textContent, '本地 Agent');
  assert.deepEqual(levels, [null]);
  assert.deepEqual(calls, [{ path: '/xbot-api/agents', method: 'GET' }], 'opening the pane only reads');
});

test('searching narrows the Agent list and can be cleared, without another read', async () => {
  const { host, calls, mounted } = await settingsPane();
  await mounted;
  const search = all(host).find(n => n.tag === 'input')!;
  assert.equal(search.getAttribute('aria-label'), '搜索 Agent');
  search.value = 'KIM'; search.oninput!();
  assert.deepEqual(rowsOf(host).map(nameOf), ['Kimi']);
  assert.deepEqual(named(host, 'setsec').map(s => s.children[0].textContent), ['已安装']);
  search.value = 'pi'; search.oninput!();
  assert.deepEqual(rowsOf(host).map(nameOf), ['Pi']);
  assert.deepEqual(named(host, 'setsec').map(s => s.children[0].textContent), ['未安装']);
  search.value = 'nothing'; search.oninput!();
  assert.equal(rowsOf(host).length, 0);
  const none = named(host, 'sknone').find(visible)!;
  assert.match(none.textContent, /没有匹配的 Agent/);
  byText(host, '清除搜索')!.onclick!();
  assert.equal(search.value, '');
  assert.equal(rowsOf(host).length, 5);
  assert.equal(named(host, 'sknone').filter(visible).length, 0);
  assert.equal(calls.length, 1);
});

test('an Agent opens on its own page with defaults and evidence, and back returns to its row', async () => {
  const { host, levels, root, calls, mounted } = await settingsPane();
  await mounted;
  rowsOf(host)[0].onclick!();
  const level = levels.at(-1)!;
  assert.equal(level.title, 'Codex');
  assert.equal(level.backLabel, '本地 Agent');
  assert.equal(rowsOf(host).length, 0, 'the list is replaced by the detail page');
  assert.ok(root.focused!.className.includes('agent-dname'), 'focus moves to the Agent name');
  const facts = named(host, 'agent-fact').map(r => r.textContent);
  assert.deepEqual(facts.slice(0, 4), ['本机已安装', '登录已有登录或配置记录', '选用可以选用', 'Bot 会话1 个执行中 · 2 个排队']);
  assert.ok(facts.includes('模型gpt-5.5') && facts.includes('推理强度high'));
  assert.deepEqual(named(host, 'agent-bots')[0].children.map(c => c.textContent), ['ada']);
  assert.match(named(host, 'setsec')[1].children[0].textContent, /接入的 Bot · 1/);
  // Paths and detection evidence sit in a folded block.
  const more = all(host).find(n => n.tag === 'details')!;
  assert.equal(more.open, false);
  assert.equal(all(more).find(n => n.tag === 'summary')!.textContent, '检测详情');
  assert.match(more.textContent, /命令codex.*接入方式cli.*检测于.*Agent IDcodex/);
  assert.equal(all(more).find(n => n.tag === 'a')!.href, '/runtime.html');
  // The in-page back link and the settings bar back both return to the list.
  const back = named(host, 'setback')[0];
  assert.equal(back.textContent, '本地 Agent');
  back.onclick!();
  assert.equal(levels.at(-1), null);
  assert.equal(rowsOf(host).length, 5);
  assert.equal(root.focused, rowsOf(host)[0], 'focus returns to the row that was opened');
  rowsOf(host)[1].onclick!();
  levels.at(-1)!.back();
  assert.equal(levels.at(-1), null);
  assert.equal(root.focused, rowsOf(host)[1]);
  assert.equal(calls.length, 1, 'opening a detail does not read again');
});

test('detail pages keep login evidence, choosability and activity as separate, unoverstated facts', async () => {
  const { host, levels, mounted } = await settingsPane();
  await mounted;
  const open = (name: string) => { levels.at(-1)?.back(); rowsOf(host).find(r => nameOf(r) === name)!.onclick!(); return named(host, 'agent-fact').map(r => r.textContent); };
  const claudeFacts = open('Claude Code');
  assert.deepEqual(claudeFacts.slice(0, 4), ['本机已安装', '登录未确认登录状态', '选用可以选用，未登录时执行会失败', 'Bot 会话状态未知']);
  assert.ok(claudeFacts.includes('模型未读取到'));
  assert.doesNotMatch(host.textContent, /空闲/);
  const kimiFacts = open('Kimi');
  assert.deepEqual(kimiFacts.slice(0, 3), ['本机已安装', '登录需要先登录', '选用请先在本机 Agent 中完成登录']);
  const hint = named(host, 'agent-hint')[0];
  assert.match(hint.textContent, /在终端运行 kimi login 后重新检测/);
  assert.equal(all(hint).find(n => n.tag === 'code')!.textContent, 'kimi login');
  const geminiFacts = open('Gemini');
  assert.deepEqual(geminiFacts.slice(0, 3), ['本机已安装', '登录未确认登录状态', '接入暂未适配']);
  assert.ok(!geminiFacts.some(f => f.startsWith('选用')));
  open('Pi');
  const piStatus = named(named(host, 'setsec')[0], 'agent-fact').map(r => r.textContent);
  assert.deepEqual(piStatus, ['本机未检测到', '接入暂未适配'], 'an Agent that is not installed claims no login, activity or defaults');
  assert.doesNotMatch(host.textContent, /空闲|本机默认|接入的 Bot/);
});

test('重新检测 is the only refresh and an open detail follows the new inventory', async () => {
  const paths: string[] = [];
  const later = { ...busyCodex, readiness: { status: 'login_required', checkedAt: 1761900600000, loginCommand: 'codex login' }, selectable: false, unavailableReason: '请先在本机 Agent 中完成登录' };
  const api = async (path: string) => { paths.push(path); return plain(path.endsWith('?refresh=1') ? { checkedAt: 1761900600000, agents: [later, pi] } : listed); };
  const { host, levels, mounted } = await settingsPane(listed, api);
  await mounted;
  rowsOf(host)[0].onclick!();
  const again = byText(host, '重新检测')!;
  assert.ok(named(host, 'agent-dhead')[0].children.includes(again), 'the detail page keeps 重新检测');
  await again.onclick!();
  assert.deepEqual(paths, ['/xbot-api/agents', '/xbot-api/agents?refresh=1']);
  assert.equal(levels.at(-1)!.title, 'Codex', 'the detail stays open');
  assert.match(named(host, 'agent-fact')[1].textContent, /需要先登录/);
  assert.match(named(host, 'agent-stamp')[0].textContent, /^检测于 /);
  assert.ok(!again.disabled);
  levels.at(-1)!.back();
  assert.deepEqual(rowsOf(host).map(hintOf), ['需要先登录 · 1 个 Bot · 1 个执行中 · 2 个排队', '未检测到']);
});

test('loading, empty and failed reads stay short', async () => {
  let answer: (value: unknown) => void = () => {};
  const pending = await settingsPane(listed, () => new Promise(resolve => { answer = resolve; }));
  assert.equal(named(pending.host, 'agent-stamp')[0].textContent, '正在读取…');
  assert.ok(byText(pending.host, '重新检测')!.disabled);
  answer({ checkedAt: 1, agents: [] });
  await pending.mounted;
  assert.equal(named(pending.host, 'sknone').filter(visible).map(n => n.textContent).join(), '没有检测到 Agent');
  assert.equal(named(pending.host, 'agent-stamp')[0].textContent, '');

  const failed = await settingsPane(listed, async () => { throw new Error('offline'); });
  await failed.mounted;
  const alert = all(failed.host).find(n => n.getAttribute('role') === 'alert')!;
  assert.ok(!alert.hidden);
  assert.equal(alert.textContent, '没能读取本地 Agent');
  assert.ok(!byText(failed.host, '重新检测')!.disabled, 're-checking stays available after a failure');
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
