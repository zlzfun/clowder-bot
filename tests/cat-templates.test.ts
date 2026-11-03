import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 猫猫模板（cat-template-rules.js、cat-templates.js）。The page scripts are
// classic browser scripts; they run in a VM with a small DOM, the way
// frontend-agents.test.ts loads agents.js. Data below is test input only.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

type Listener = (ev: any) => unknown;
class Txt { parent: El | null = null; constructor(public textContent: string) {} }
class Doc {
  body: El; focused: El | null = null;
  constructor() { this.body = new El('body', this); }
  createElement(tag: string) { return new El(tag, this); }
  get activeElement() { return this.focused || this.body; }
}
class El {
  children: Array<El | Txt> = []; parent: El | null = null; attrs: Record<string, string> = {}; listeners: Record<string, Listener[]> = {};
  className = ''; id = ''; type = ''; value = ''; hidden = false; disabled = false; tabIndex = 0; placeholder = '';
  maxLength = 0; rows = 0; autocomplete = ''; spellcheck = true; htmlFor = ''; title = '';
  constructor(readonly tag: string, readonly doc: Doc) {}
  get classList() {
    const names = () => new Set(this.className.split(' ').filter(Boolean));
    const write = (set: Set<string>) => { this.className = [...set].join(' '); };
    return {
      add: (name: string) => { const s = names(); s.add(name); write(s); },
      remove: (name: string) => { const s = names(); s.delete(name); write(s); },
      toggle: (name: string, on?: boolean) => { const s = names(); if (on ?? !s.has(name)) s.add(name); else s.delete(name); write(s); },
      contains: (name: string) => names().has(name),
    };
  }
  append(...nodes: Array<El | Txt | string>) {
    for (const item of nodes) {
      const child: El | Txt = typeof item === 'string' ? new Txt(item) : item;
      if (child.parent) child.parent.children = child.parent.children.filter(c => c !== child);
      child.parent = this; this.children.push(child);
    }
  }
  replaceChildren(...nodes: Array<El | Txt | string>) { for (const c of this.children) c.parent = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; } }
  get textContent(): string { return this.children.map(c => c.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); if (value) this.append(String(value)); }
  setAttribute(key: string, value: unknown) { this.attrs[key] = String(value); }
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  removeAttribute(key: string) { delete this.attrs[key]; }
  addEventListener(type: string, fn: Listener) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type: string, init: Record<string, unknown> = {}) {
    const ev: any = { type, target: this, shiftKey: false, ...init, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    for (let n: El | null = this; n && !ev.stopped; n = n.parent) { ev.currentTarget = n; for (const fn of n.listeners[type] || []) fn(ev); }
    return ev;
  }
  click() { if (!this.disabled) this.dispatch('click'); }
  focus() { this.doc.focused = this; }
  get isConnected(): boolean { for (let n: El | null = this; n; n = n.parent) if (n === this.doc.body) return true; return false; }
  querySelectorAll() { return all(this).filter(n => ['button', 'input', 'select', 'textarea'].includes(n.tag)); }
  getClientRects() { for (let n: El | null = this; n; n = n.parent) if (n.hidden) return []; return [{}]; }
  scrollIntoView() {}
}
const all = (root: El): El[] => root.children.flatMap(c => c instanceof El ? [c, ...all(c)] : []);
const has = (n: El, cls: string) => n.className.split(' ').includes(cls);
const named = (root: El, cls: string) => all(root).filter(n => has(n, cls));
const byText = (root: El, text: string) => all(root).find(n => n.tag === 'button' && n.textContent === text);
const shown = (n: El) => n.getClientRects().length > 0;
// The control of a labelled .field: the element its <label> points at.
function control(root: El, label: string): El {
  const lab = all(root).find(n => n.tag === 'label' && n.textContent === label && shown(n));
  assert.ok(lab, 'no field ' + label);
  const target = all(root).find(n => n.id && n.id === lab!.htmlFor);
  assert.ok(target, 'no control for ' + label);
  return target!;
}
const options = (select: El) => select.children.filter((c): c is El => c instanceof El).map(o => ({ value: o.value, text: o.textContent, disabled: o.disabled }));
function choose(select: El, value: string) { select.value = value; select.dispatch('change'); }
function type(input: El, value: string) { input.value = value; input.dispatch('input'); input.dispatch('change'); }

function browser() {
  const doc = new Doc();
  const faces = ['ragdoll', 'maine-coon', 'siamese', 'turkish-van', 'dsh', 'dragon-li', 'bengal', 'golden-chinchilla'];
  const window: any = { crypto: globalThis.crypto, ClowderAvatars: { presets: faces.map(id => ({ id })), createPortrait: (seed: string) => { const svg = doc.createElement('svg'); svg.setAttribute('data-cat-id', seed.replace(/^cat:/, '')); return svg; } } };
  const context = vm.createContext({ window, document: doc });
  vm.runInContext(read('client/public/cat-template-rules.js'), context);
  vm.runInContext(read('client/public/cat-templates.js'), context);
  return { doc, T: window.ClowderCatTemplates, R: window.ClowderCatTemplateRules };
}

type Call = { path: string; method: string; body?: any };
type Route = (path: string, method: string, body: any) => unknown;
function server(route: Route) {
  const calls: Call[] = [];
  const api = async (path: string, opt: { method?: string; body?: unknown } = {}) => {
    const method = opt.method || 'GET', body = opt.body === undefined ? undefined : plain(opt.body);
    calls.push({ path, method, ...(body === undefined ? {} : { body }) });
    const out = await route(path, method, body);
    return out === undefined ? undefined : plain(out);
  };
  return { api, calls };
}
const fail = (status: number, message = 'request failed') => Object.assign(new Error(message), { status });
function defer<T = unknown>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

// ---- test input ----
const breeds = [['ragdoll', '布偶猫'], ['maine-coon', '缅因猫'], ['siamese', '暹罗猫'], ['dragon-li', '狸花猫'], ['moonshot', '梵花猫'], ['bengal', '孟加拉猫'], ['golden-chinchilla', '金渐层'], ['dsh', '蓝灰短毛猫']].map(([id, name]) => ({ id, name }));
const tpl = (over: Record<string, unknown> = {}) => ({
  id: 't-ragdoll', revision: 3, name: '布偶猫', nameHint: '宪宪', source: { kind: 'native-seed', breedId: 'ragdoll', variantId: 'opus-default' },
  runtimeId: 'claude', breed: { mode: 'auto' }, model: { mode: 'explicit', value: 'claude-opus-4-6' }, effort: { mode: 'inherit' },
  portrait: { roleDescription: '主架构师', personality: '温柔', strengths: ['架构'], caution: null }, ...over,
});
const templates = [
  tpl(),
  tpl({ id: 't-maine', name: '缅因猫', nameHint: '砚砚', source: { kind: 'native-seed', breedId: 'maine-coon', variantId: 'codex-default' }, runtimeId: 'codex', model: { mode: 'inherit' }, effort: { mode: 'explicit', value: 'high' }, portrait: { roleDescription: '审查' } }),
  tpl({ id: 't-kimi', name: '梵花猫', nameHint: '墨墨', source: { kind: 'native-seed', breedId: 'moonshot', variantId: 'kimi-default' }, runtimeId: 'kimi', model: { mode: 'inherit' }, portrait: { roleDescription: '研究' } }),
  tpl({ id: 't-glm', name: '狸花猫', nameHint: '小狸花', source: { kind: 'native-seed', breedId: 'dragon-li', variantId: 'glm52-default' }, runtimeId: null, model: { mode: 'explicit', value: 'zhipu/glm-5.2' }, portrait: { roleDescription: '编码' } }),
];
const agent = (over: Record<string, unknown> = {}) => ({
  id: 'codex', label: 'Codex', installed: true, supported: true, selectable: true, configuredModel: 'gpt-5.5', configuredEffort: 'medium',
  readiness: { status: 'configured', checkedAt: 1761900000000 }, ...over,
});
const agents = [
  agent(),
  agent({ id: 'claude', label: 'Claude Code', configuredModel: null, configuredEffort: null, readiness: { status: 'unknown', checkedAt: null } }),
  agent({ id: 'kimi', label: 'Kimi', selectable: false, configuredModel: null, configuredEffort: null, readiness: { status: 'login_required', checkedAt: 1 } }),
  agent({ id: 'opencode', label: 'OpenCode', configuredModel: null, configuredEffort: null }),
];
const models: Record<string, any> = {
  codex: { status: 'live', defaultModel: 'gpt-5.5', defaultEffort: 'medium', models: [
    { value: 'gpt-5.5', label: 'GPT-5.5', efforts: [{ value: 'low', label: 'low' }, { value: 'medium', label: 'medium' }, { value: 'high', label: 'high' }, { value: 'xhigh', label: 'xhigh' }] },
    { value: 'gpt-5.4', label: 'GPT-5.4', efforts: [] }] },
  claude: { status: 'configured', defaultModel: 'claude-opus-4-6', models: [{ value: 'claude-opus-4-6', label: 'Opus 4.6' }, { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }] },
  opencode: { status: 'unavailable', models: [] },
  kimi: { status: 'configured', models: [] },
};
function backend(over: Partial<Record<'catalog' | 'agents' | 'models' | 'create' | 'put' | 'del' | 'get', (body: any, path: string) => unknown>> = {}) {
  return server((path, method, body) => {
    if (path === '/xbot-api/cat-templates' && method === 'GET') return over.catalog ? over.catalog(body, path) : { templates, breeds };
    if (path === '/xbot-api/agents') return over.agents ? over.agents(body, path) : { agents };
    const m = /^\/xbot-api\/agents\/([^/]+)\/models$/.exec(path);
    if (m && method === 'POST') return over.models ? over.models(body, m[1]) : models[decodeURIComponent(m[1])] || { status: 'unavailable', models: [] };
    if (path === '/xbot-api/bots' && method === 'POST') return over.create ? over.create(body, path) : { name: body.name, native_id: 'cat_new' };
    if (path.startsWith('/xbot-api/cat-templates/') && method === 'PUT') return over.put ? over.put(body, path) : { template: { ...templates[0], ...body, revision: 4 } };
    if (path.startsWith('/xbot-api/cat-templates/') && method === 'DELETE') return over.del ? over.del(body, path) : { status: 'ok' };
    if (path.startsWith('/xbot-api/cat-templates/') && method === 'GET') return over.get ? over.get(body, path) : { template: templates[0] };
    if (path === '/xbot-api/cat-templates' && method === 'POST') return { template: { ...body, id: 't-new', revision: 1, source: { kind: 'user' } } };
    throw fail(404);
  });
}

// ---- rules ----
test('breed follows the model family, never the version or the Agent; moonshot shows the turkish-van portrait', () => {
  const { R } = browser();
  const family = (model: string) => R.familyBreed(model).breedId;
  // Versions, dates, sub-series and letter case never move a model to another family.
  for (const model of ['claude-opus-4-6', 'claude-opus-4-5-20251101', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-fable-5', 'opus-4.7', 'Claude Opus 4.6 (Thinking)', '  claude-opus-4-6  ']) assert.equal(family(model), 'ragdoll', model);
  for (const model of ['gpt-5.3-codex', 'gpt-5.4', 'GPT-5.6-sol', 'gpt-pro', 'codex-mini-latest', 'o1', 'o3', 'o4-mini']) assert.equal(family(model), 'maine-coon', model);
  for (const model of ['Gemini 3.1 Pro (High)', 'gemini-3.6-flash']) assert.equal(family(model), 'siamese', model);
  for (const model of ['zhipu/glm-5.2', 'glm-4.5-air', 'GLM-5']) assert.equal(family(model), 'dragon-li', model);
  for (const model of ['kimi-code/kimi-for-coding', 'moonshot-v1-128k', 'Kimi-K2']) assert.equal(family(model), 'moonshot', model);
  for (const model of ['deepseek-v3.2', 'DeepSeek-R1', 'deepseek/deepseek-chat', 'dsh']) assert.equal(family(model), 'dsh', model);
  // Native knows o1, o3 and o4 only, and only as the whole model name; no loose substrings.
  for (const model of ['o9', 'o5-mini', 'openai/o4-mini', 'qwen3-coder', 'chatglm3']) assert.deepEqual(plain(R.familyBreed(model)), { breedId: null, code: 'unknown' }, model);
  // Two families in one name is not a guess between them.
  for (const model of ['gpt-to-claude-bridge', 'claude-opus-via-gpt-5', 'deepseek-gemini-merge']) assert.deepEqual(plain(R.familyBreed(model)), { breedId: null, code: 'ambiguous' }, model);
  assert.deepEqual(plain(R.familyBreed('  ')), { breedId: null, code: 'empty' });
  assert.equal(R.avatarOf('moonshot'), 'turkish-van');
  assert.equal(R.avatarOf('ragdoll'), 'ragdoll');
  assert.equal(R.avatarOf('dsh'), 'dsh');

  const auto = (over: Record<string, unknown>, ctx: Record<string, unknown> = {}) => R.resolveBreed(R.config({ runtimeId: 'opencode', ...over }), { breeds, ...ctx });
  assert.equal(auto({}).breedId, null, 'a multi-model Agent with no known default needs a choice');
  assert.equal(auto({}, { defaultModel: 'zhipu/glm-5.2' }).breedId, 'dragon-li');
  assert.equal(auto({ model: { mode: 'explicit', value: 'claude-opus-4-6' } }).breedId, 'ragdoll');
  assert.equal(auto({}, { defaultModel: 'deepseek-v3.2' }).breedId, 'dsh');
  assert.deepEqual(plain(auto({ model: { mode: 'explicit', value: 'claude-gpt-router' } })), { breedId: null, how: 'auto', code: 'ambiguous', model: 'claude-gpt-router' }, 'a mixed name asks for a breed');
  assert.equal(auto({ model: { mode: 'explicit', value: 'o9' } }).breedId, null);
  assert.equal(auto({ breed: { mode: 'explicit', breedId: 'bengal' }, model: { mode: 'explicit', value: 'claude-opus-4-6' } }).breedId, 'bengal', 'explicit breed is kept');
  assert.equal(auto({ breed: { mode: 'explicit', breedId: 'gpt-pro' } }).breedId, 'gpt-pro', 'an explicit native breed outside the list is preserved');
  assert.equal(auto({ model: { mode: 'explicit', value: 'gemini-3' } }, { breeds: breeds.filter(b => b.id !== 'siamese') }).breedId, null);
  assert.equal(R.resolveBreed(R.config({ runtimeId: null }), { breeds, defaultModel: 'gpt-5.5' }).breedId, null, 'no Agent, no default to read');
});

test('effort capability comes from native runtime-models: model efforts first, then the queried effortOptions', () => {
  const { R } = browser();
  const cfg = (model?: string) => R.config({ runtimeId: 'codex', model: model ? { mode: 'explicit', value: model } : { mode: 'inherit' } });
  const base = { query: '', data: models.codex };
  assert.deepEqual(plain(R.effortCapability(cfg(), [base])).values.map((v: any) => v.value), ['low', 'medium', 'high', 'xhigh'], 'inherit reads the default model');
  assert.equal(R.effortCapability(cfg('gpt-5.4'), [base]).state, 'unsupported', 'an explicit empty list');
  assert.equal(R.effortCapability(cfg('gpt-9'), [base]).state, 'unknown', 'a missing field is unknown');
  const asked = { query: 'gpt-9', data: { status: 'live', models: [], effortOptions: [{ value: 'max', label: 'max' }] } };
  assert.deepEqual(plain(R.effortCapability(cfg('gpt-9'), [base, asked])), { state: 'supported', values: [{ value: 'max', label: 'max' }] });
  const own = { query: '', data: { status: 'live', defaultModel: 'gpt-5.5', models: [{ value: 'gpt-5.5', efforts: [{ value: 'high' }] }], effortOptions: [] } };
  assert.equal(R.effortCapability(cfg(), [own]).state, 'supported', 'model efforts beat effortOptions');
  assert.equal(R.effortCapability(cfg(), [{ query: '', data: { status: 'unavailable', models: [], effortOptions: [] } }]).state, 'unknown', 'unavailable claims nothing');
  assert.equal(R.effortCapability(R.config({}), [base]).state, 'no_agent');

  const max = R.config({ runtimeId: 'codex', effort: { mode: 'explicit', value: 'max' } });
  assert.equal(R.reconcileEffort(max, { state: 'unknown' }).cleared, '', 'unknown keeps an explicit value');
  const off = R.reconcileEffort(max, { state: 'supported', values: [{ value: 'high' }, { value: 'xhigh' }] });
  assert.equal(off.cleared, 'max');
  assert.deepEqual(plain(off.config.effort), { mode: 'inherit' }, 'back to the default, not a neighbouring level');
  assert.deepEqual(plain(R.reconcileEffort(max, { state: 'unsupported' }).config.effort), { mode: 'inherit' });
});

test('another Agent resets model and effort to its defaults; the portrait and an explicit breed stay', () => {
  const { R } = browser();
  const before = R.config(tpl({ breed: { mode: 'explicit', breedId: 'bengal' }, effort: { mode: 'explicit', value: 'max' } }));
  const after = plain(R.changeAgent(before, 'codex'));
  assert.equal(after.runtimeId, 'codex');
  assert.deepEqual(after.model, { mode: 'inherit' });
  assert.deepEqual(after.effort, { mode: 'inherit' });
  assert.deepEqual(after.breed, { mode: 'explicit', breedId: 'bengal' });
  assert.deepEqual(after.portrait, plain(before.portrait));
  assert.deepEqual(plain(R.changeAgent(R.config(tpl()), 'codex').breed), { mode: 'auto' });
});

test('request bodies carry tagged choices, keep unknown efforts and drop refused ones, and never expose provenance', () => {
  const { R } = browser();
  const cfg = R.config(tpl({ model: { mode: 'explicit', value: '  ' }, effort: { mode: 'explicit', value: 'max' } }));
  const kept = plain(R.catConfig(cfg, { state: 'unknown' }));
  assert.deepEqual(kept.model, { mode: 'inherit' }, 'an empty explicit model is the default');
  assert.deepEqual(kept.effort, { mode: 'explicit', value: 'max' });
  assert.deepEqual(kept.portrait.strengths, ['架构']);
  assert.equal(kept.portrait.caution, null);
  assert.deepEqual(plain(R.catConfig(cfg, { state: 'unsupported' })).effort, { mode: 'inherit' });
  const faces = ['ragdoll', 'turkish-van'];
  const body = plain(R.createBody({ name: ' 宪宪 ', cfg, cap: { state: 'unknown' }, source: { id: 't-ragdoll', revision: 3 }, breedId: 'moonshot', faces }));
  assert.deepEqual(Object.keys(body).sort(), ['avatar_seed', 'catConfig', 'name', 'sourceTemplate']);
  assert.equal(body.name, '宪宪');
  assert.equal(body.avatar_seed, 'cat:turkish-van');
  assert.deepEqual(body.sourceTemplate, { id: 't-ragdoll', revision: 3 });
  assert.equal('templateId' in body, false, 'templateId stays the avatar field');
  const scratch = plain(R.createBody({ name: 'a', cfg, breedId: 'gpt-pro', faces }));
  assert.equal('sourceTemplate' in scratch, false);
  assert.equal('avatar_seed' in scratch, false, 'no seed for a breed without a portrait');
  const saved = plain(R.templateBody({ ...R.template(tpl()), name: ' 新 ', nameHint: ' 宪 ' }, { state: 'unknown' }));
  assert.deepEqual(Object.keys(saved).sort(), ['breed', 'effort', 'model', 'name', 'nameHint', 'portrait', 'runtimeId']);
  assert.equal(saved.name, '新');
});

test('creation needs a usable Agent and a breed; a template may stay a draft', () => {
  const { R } = browser();
  const issues = (cfg: Record<string, unknown>, ctx: Record<string, unknown>) => plain(R.configIssues(R.config(cfg), { breeds, agents, ...ctx })).map((i: any) => i.field);
  assert.deepEqual(issues({}, { purpose: 'create' }), ['agent', 'breed']);
  assert.deepEqual(issues({}, { purpose: 'template' }), []);
  assert.deepEqual(issues({ runtimeId: 'kimi', model: { mode: 'explicit', value: 'kimi-k2' } }, { purpose: 'create' }), ['agent']);
  assert.deepEqual(issues({ runtimeId: 'kimi', model: { mode: 'explicit', value: 'kimi-k2' } }, { purpose: 'create', agents: null }), [], 'an unread Agent list blocks nothing');
  assert.deepEqual(issues({ runtimeId: 'opencode' }, { purpose: 'create', breeds: [] }), [], 'no list to choose from, no demand');
  assert.deepEqual(issues({ runtimeId: 'codex', effort: { mode: 'explicit', value: 'x high' } }, { purpose: 'template' }), ['effort']);
  assert.equal(R.usable(agents[2], 'template'), true, 'a template may name an Agent awaiting login');
  assert.equal(R.usable(agents[2], 'create'), false);
  assert.equal(R.catNameProblem('', []), '填写名字');
  assert.equal(R.catNameProblem('a<b', []), '名字只能用文字、数字、空格和 _ . -');
  assert.equal(R.catNameProblem('宪宪', ['宪宪']), '已有同名猫猫');
  assert.equal(R.freeName('宪宪', ['宪宪', '宪宪 2']), '宪宪 3');
});

test('the module keeps no sample data, storage or long guidance', () => {
  const source = read('client/public/cat-templates.js') + read('client/public/cat-template-rules.js');
  for (const banned of ['sessionStorage', 'localStorage', 'fixture', 'template-lab', 'variantId', 'upstreamCommit', '不会启动', '修订']) assert.equal(source.includes(banned), false, banned);
});

// ---- 设置 → 模板 ----
async function mounted(over: Parameters<typeof backend>[0] = {}) {
  const b = browser(), srv = backend(over), host = b.doc.createElement('div'), levels: any[] = [];
  b.doc.body.append(host);
  let live = true;
  await b.T.mount({ api: srv.api, host, isCurrent: () => live, onLevel: (level: any) => levels.push(level) });
  return { ...b, ...srv, host, levels, leave: () => { live = false; } };
}

test('设置 → 模板 lists every template flat with a portrait and one summary line', async () => {
  const s = await mounted();
  const rows = named(s.host, 'ct-row');
  assert.deepEqual(rows.map(r => r.children.find((c): c is El => c instanceof El && has(c, 'tx'))!.children[0].textContent), ['布偶猫', '缅因猫', '梵花猫', '狸花猫']);
  assert.deepEqual(rows.map(r => named(r, 'hint')[0].textContent), ['Claude Code · claude-opus-4-6', 'Codex · 默认模型 · high', 'Kimi · 默认模型', '未选 Agent · zhipu/glm-5.2']);
  assert.deepEqual(rows.map(r => all(r).find(n => n.tag === 'svg')?.getAttribute('data-cat-id') ?? 'none'), ['ragdoll', 'maine-coon', 'none', 'dragon-li'], 'Kimi without a known default model is not guessed from the Agent');
  assert.equal(all(s.host).some(n => n.tag === 'select'), false, 'no breed filter');
  assert.equal(named(s.host, 'tl-group-head').length + all(s.host).filter(n => n.tag === 'h3').length, 0, 'no breed headings');
  assert.doesNotMatch(s.host.textContent, /native-seed|opus-default|修订|revision/);
  assert.equal(s.levels.at(-1), null);
  assert.ok(all(s.host).find(n => n.getAttribute('aria-label') === '新建模板'));

  const search = all(s.host).find(n => n.tag === 'input' && n.type === 'search')!;
  type(search, 'codex');
  assert.deepEqual(named(s.host, 'ct-row').map(r => named(r, 'hint')[0].textContent), ['Codex · 默认模型 · high']);
  type(search, '没有这种');
  assert.equal(named(s.host, 'sklist')[0].hidden, true);
  assert.equal(named(s.host, 'sknone')[0].hidden, false);
});

test('a missing template API shows a short error, not sample data', async () => {
  const s = await mounted({ catalog: () => { throw fail(404, '<html>Cannot GET</html>'); } });
  assert.match(s.host.textContent, /模板暂不可用/);
  assert.equal(named(s.host, 'ct-row').length, 0);
  assert.ok(byText(s.host, '重试'));
  assert.doesNotMatch(s.host.textContent, /Cannot GET/);
});

test('editing saves the template with its revision; changing the Agent resets the model to the default', async () => {
  const s = await mounted();
  named(s.host, 'ct-row')[0].click();
  await settle();
  const level = s.levels.at(-1);
  assert.equal(level.title, '布偶猫');
  assert.equal(level.backLabel, '模板');
  assert.ok(s.calls.some(c => c.path === '/xbot-api/agents/claude/models' && c.method === 'POST'));
  const model = control(s.host, '模型');
  assert.equal(model.value, 'claude-opus-4-6');
  assert.deepEqual(options(model).map(o => o.text), ['默认（Opus 4.6）', 'Opus 4.6', 'Sonnet 4.6', '其他…']);
  const agent = control(s.host, 'Agent');
  assert.deepEqual(options(agent).map(o => [o.text, o.disabled]), [['Codex', false], ['Claude Code · 未确认登录', false], ['Kimi · 需要登录', false], ['OpenCode', false]]);
  type(control(s.host, '性格'), '更温柔');
  choose(agent, 'codex');
  await settle();
  assert.equal(control(s.host, '模型').value, '', 'back to the Agent default');
  assert.equal(control(s.host, '性格').value, '更温柔', 'the portrait the user typed stays');
  assert.deepEqual(options(control(s.host, '推理强度')).map(o => o.value), ['', 'low', 'medium', 'high', 'xhigh']);
  byText(s.host, '保存')!.click();
  await settle();
  const put = s.calls.find(c => c.method === 'PUT')!;
  assert.equal(put.path, '/xbot-api/cat-templates/t-ragdoll');
  assert.equal(put.body.expectedRevision, 3);
  assert.equal(put.body.runtimeId, 'codex');
  assert.deepEqual(put.body.model, { mode: 'inherit' });
  assert.equal(put.body.portrait.personality, '更温柔');
  assert.deepEqual(put.body.portrait.strengths, ['架构']);
  for (const hidden of ['id', 'revision', 'source']) assert.equal(hidden in put.body, false, hidden);
  assert.match(s.host.textContent, /已保存「布偶猫」/);
  assert.equal(s.levels.at(-1), null);
});

test('a save conflict reloads the stored template instead of overwriting it', async () => {
  const fresh = { ...tpl(), revision: 7, portrait: { roleDescription: '别处改过' } };
  const s = await mounted({ put: () => { throw fail(409, 'revision mismatch'); }, get: () => ({ template: fresh }) });
  named(s.host, 'ct-row')[0].click();
  await settle();
  byText(s.host, '保存')!.click();
  await settle();
  assert.match(s.host.textContent, /模板已在别处修改，已载入最新内容/);
  assert.equal(control(s.host, '职责').value, '别处改过');
  byText(s.host, '保存')!.click();
  await settle();
  assert.equal(s.calls.filter(c => c.method === 'PUT').at(-1)!.body.expectedRevision, 7);
});

test('delete asks once, sends the revision, and reports the server failure without pretending', async () => {
  let refuse = true;
  const s = await mounted({ del: () => { if (refuse) throw fail(404, 'not found'); return { status: 'ok' }; } });
  named(s.host, 'ct-row')[1].click();
  await settle();
  byText(s.host, '删除')!.click();
  const layer = named(s.host, 'nestcard')[0];
  assert.match(layer.textContent, /删除模板「缅因猫」？/);
  byText(layer, '删除')!.click();
  await settle();
  assert.match(layer.textContent, /没能删除：没有找到这个模板/);
  assert.ok(layer.isConnected, 'the layer stays open');
  refuse = false;
  byText(layer, '删除')!.click();
  await settle();
  const del = s.calls.filter(c => c.method === 'DELETE').at(-1)!;
  assert.equal(del.path, '/xbot-api/cat-templates/t-maine');
  assert.deepEqual(del.body, { expectedRevision: 3 });
  assert.match(s.host.textContent, /已删除「缅因猫」/);
});

test('teardown during the first read leaves nothing behind', async () => {
  const gate = defer<unknown>();
  const b = browser(), srv = backend({ catalog: () => gate.promise }), host = b.doc.createElement('div'), levels: unknown[] = [];
  b.doc.body.append(host);
  const done = b.T.mount({ api: srv.api, host, onLevel: (l: unknown) => levels.push(l) });
  b.T.teardown();
  gate.resolve({ templates, breeds });
  await done;
  await settle();
  assert.equal(host.children.length, 0);
  assert.equal(levels.length, 1, 'only the opening call before teardown');
});

// ---- 新建猫猫 ----
function creating(over: Parameters<typeof backend>[0] = {}, opts: Record<string, unknown> = {}) {
  const b = browser(), srv = backend(over), opener = b.doc.createElement('button'), created: unknown[] = [];
  b.doc.body.append(opener);
  const handle = b.T.openCreate({ api: srv.api, opener, onCreated: (c: unknown) => { created.push(plain(c)); }, names: ['宪宪'], ...opts });
  const modal = () => named(b.doc.body, 'ct-modal')[0];
  const submit = () => named(b.doc.body, 'ct-card')[0].dispatch('submit');
  return { ...b, ...srv, opener, created, handle, modal, submit };
}

test('新建猫猫 lists templates flat with 从零开始 last; a template fills the form with its configuration folded', async () => {
  const c = creating();
  await settle();
  const rows = named(c.modal(), 'skrow');
  assert.deepEqual(rows.map(r => r.textContent), ['布偶猫Claude Code · claude-opus-4-6', '缅因猫Codex · 默认模型 · high', '梵花猫Kimi · 默认模型', '狸花猫未选 Agent · zhipu/glm-5.2', '从零开始']);
  assert.equal(c.doc.focused, rows[0]);
  rows[1].click();
  await settle();
  assert.equal(control(c.modal(), '名字').value, '砚砚');
  assert.equal(named(c.modal(), 'ct-custom')[0].hidden, true, 'configuration starts folded');
  const more = named(c.modal(), 'ct-more')[0];
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  assert.match(more.textContent, /自定义配置Codex · 默认模型 · high/);
  assert.equal(all(c.modal()).find(n => n.tag === 'svg')!.getAttribute('data-cat-id'), 'maine-coon');
  c.submit();
  await settle();
  const post = c.calls.find(x => x.path === '/xbot-api/bots')!;
  assert.match(post.body.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  delete post.body.idempotencyKey;
  assert.deepEqual(post.body, {
    name: '砚砚',
    catConfig: { runtimeId: 'codex', breed: { mode: 'auto' }, model: { mode: 'inherit' }, effort: { mode: 'explicit', value: 'high' }, portrait: { roleDescription: '审查' } },
    sourceTemplate: { id: 't-maine', revision: 3 },
    avatar_seed: 'cat:maine-coon',
  });
  assert.deepEqual(c.created, [{ name: '砚砚', native_id: 'cat_new' }]);
  assert.equal(c.modal(), undefined, 'closed after success');
  assert.equal(c.doc.focused, c.opener);
  assert.equal(c.calls.some(x => /messages|invocations|start/.test(x.path)), false, 'nothing is sent or started');
});

test('从零开始 opens the configuration, needs a breed it cannot infer, and sends no source template', async () => {
  const c = creating();
  await settle();
  named(c.modal(), 'ct-scratch')[0].click();
  await settle();
  assert.equal(named(c.modal(), 'ct-more').length, 0);
  assert.equal(named(c.modal(), 'ct-custom')[0].hidden, false);
  assert.equal(control(c.modal(), 'Agent').value, 'codex', 'the Agent with a configuration record');
  assert.deepEqual(options(control(c.modal(), 'Agent')).filter(o => o.disabled).map(o => o.value), ['kimi'], 'an Agent awaiting login cannot create');
  choose(control(c.modal(), 'Agent'), 'opencode');
  await settle();
  assert.match(c.modal().textContent, /无法读取模型列表/);
  type(control(c.modal(), '名字'), '新猫');
  c.submit();
  await settle();
  assert.equal(c.calls.some(x => x.path === '/xbot-api/bots'), false, 'a breed nobody can infer is asked for');
  assert.match(c.modal().textContent, /选择猫种/);
  assert.equal(c.doc.focused, control(c.modal(), '猫种'));
  choose(control(c.modal(), '猫种'), 'golden-chinchilla');
  c.submit();
  await settle();
  const post = c.calls.find(x => x.path === '/xbot-api/bots')!;
  assert.equal('sourceTemplate' in post.body, false);
  assert.deepEqual(post.body.catConfig.breed, { mode: 'explicit', breedId: 'golden-chinchilla' });
  assert.equal(post.body.catConfig.runtimeId, 'opencode');
});

test('saving blocks a second submit and Escape; a failure keeps the dialog with a short error', async () => {
  const gate = defer<unknown>();
  const c = creating({ create: () => gate.promise });
  await settle();
  named(c.modal(), 'ct-row')[0].click();
  await settle();
  c.submit();
  await settle();
  c.submit();
  named(c.modal(), 'ct-card')[0].dispatch('keydown', { key: 'Escape' });
  await settle();
  assert.equal(c.calls.filter(x => x.path === '/xbot-api/bots').length, 1);
  assert.ok(c.modal(), 'Escape does not close while saving');
  const ok = all(c.modal()).find(n => n.tag === 'button' && n.type === 'submit')!;
  assert.equal(ok.disabled, true);
  assert.equal(ok.textContent, '正在创建…');
  gate.reject(fail(400, 'Unrecognized key: "catConfig"'));
  await settle();
  assert.ok(c.modal());
  assert.match(c.modal().textContent, /没能创建，请稍后再试/);
  assert.doesNotMatch(c.modal().textContent, /Unrecognized/);
  assert.equal(ok.disabled, false);
  assert.deepEqual(c.created, []);
  c.submit();
  await settle();
  type(control(c.modal(), '名字'), '宪宪 3');
  c.submit();
  await settle();
  const keys = c.calls.filter(x => x.path === '/xbot-api/bots').map(x => x.body.idempotencyKey);
  assert.equal(keys.length, 3);
  assert.equal(keys[1], keys[0], 'the same body retries with the same key');
  assert.notEqual(keys[2], keys[1], 'a changed body is a new request');
  const ev = control(c.modal(), '名字').dispatch('keydown', { key: 'Escape' });
  assert.equal(ev.stopped, true, 'the app never sees this Escape');
  assert.equal(c.modal(), undefined);
  assert.equal(c.doc.focused, c.opener);
});

test('a conflicting template revision is re-read before the next try', async () => {
  let first = true;
  const c = creating({ create: () => { if (first) { first = false; throw fail(409, 'stale'); } return { name: '宪宪 2', native_id: 'cat_2' }; }, get: () => ({ template: { ...tpl(), revision: 5 } }) });
  await settle();
  named(c.modal(), 'ct-row')[0].click();
  await settle();
  assert.equal(control(c.modal(), '名字').value, '宪宪 2', 'a free name next to an existing cat');
  c.submit();
  await settle();
  assert.match(c.modal().textContent, /模板刚有改动，已重新读取，请确认后再创建/);
  c.submit();
  await settle();
  const posts = c.calls.filter(x => x.path === '/xbot-api/bots');
  assert.deepEqual(posts.map(p => p.body.sourceTemplate.revision), [3, 5]);
  assert.deepEqual(c.created, [{ name: '宪宪 2', native_id: 'cat_2' }]);
});

test('a late model answer for a previous Agent never paints over the current one', async () => {
  const slow = defer<unknown>();
  const c = creating({ models: (_body, id) => id === 'codex' ? slow.promise : models[id] });
  await settle();
  named(c.modal(), 'ct-scratch')[0].click();
  await settle();
  choose(control(c.modal(), 'Agent'), 'claude');
  await settle();
  slow.resolve(models.codex);
  await settle();
  const effort = control(c.modal(), '推理强度');
  assert.equal(effort.tag, 'input', 'Claude Code effort is unknown, so it can be typed');
  assert.equal(control(c.modal(), '模型').value, '');
  assert.deepEqual(options(control(c.modal(), '模型')).map(o => o.text), ['默认（Opus 4.6）', 'Opus 4.6', 'Sonnet 4.6', '其他…']);
});

test('effort: unknown keeps an explicit value; known unsupported clears it to the default and says so', async () => {
  const keep = creating({}, { templateId: 't-ragdoll' });
  await settle();
  named(keep.modal(), 'ct-more')[0].click();
  const typed = control(keep.modal(), '推理强度');
  assert.equal(typed.tag, 'input');
  type(typed, 'max');
  keep.submit();
  await settle();
  const sent = keep.calls.find(x => x.path === '/xbot-api/bots')!.body.catConfig;
  assert.deepEqual(sent.effort, { mode: 'explicit', value: 'max' }, 'unknown capability keeps the explicit value');
  assert.ok(keep.calls.some(x => x.path === '/xbot-api/agents/claude/models' && x.body.model === 'claude-opus-4-6'), 'the model itself was asked about before giving up as unknown');

  const drop = creating({}, { templateId: 't-maine' });
  await settle();
  named(drop.modal(), 'ct-more')[0].click();
  choose(control(drop.modal(), '模型'), 'gpt-5.4');
  await settle();
  const effort = control(drop.modal(), '推理强度');
  assert.equal(effort.disabled, true);
  assert.deepEqual(options(effort).map(o => o.text), ['不支持']);
  assert.match(drop.modal().textContent, /high 不适用，已改为默认/);
  drop.submit();
  await settle();
  assert.deepEqual(drop.calls.find(x => x.path === '/xbot-api/bots')!.body.catConfig.effort, { mode: 'inherit' });
});

test('the detail summary shows the copied configuration without provenance', () => {
  const { T, doc } = browser();
  const list = T.renderSummary(tpl({ breed: { mode: 'explicit', breedId: 'moonshot' }, runtimeId: 'kimi', model: { mode: 'inherit' } }), { agents, breeds });
  doc.body.append(list);
  assert.equal(list.textContent, 'AgentKimi模型默认推理强度默认猫种梵花猫');
});

test('the detail summary names a breed only from the catalog and never shows a breed ID', () => {
  const { R } = browser();
  const breedRow = (cfg: Record<string, unknown>, ctx: Record<string, unknown>) => plain(R.describe(tpl(cfg), { agents, ...ctx })).find(([label]: [string]) => label === '猫种');
  const explicit = (breedId: string) => ({ breed: { mode: 'explicit', breedId } });
  // Known IDs take the catalog name, including moonshot's.
  assert.deepEqual(breedRow(explicit('ragdoll'), { breeds }), ['猫种', '布偶猫']);
  assert.deepEqual(breedRow(explicit('moonshot'), { breeds }), ['猫种', '梵花猫']);
  assert.deepEqual(breedRow({ breed: { mode: 'auto' }, runtimeId: 'claude', model: { mode: 'explicit', value: 'claude-opus-5-5' } }, { breeds }), ['猫种', '布偶猫']);
  // An older native cat's synthetic ID is not a name; the row is left out and the config is untouched.
  const legacy = tpl(explicit('bot-f4eb9bcb-844'));
  const rows = plain(R.describe(legacy, { agents, breeds }));
  assert.deepEqual(rows.map(([label]: [string]) => label), ['Agent', '模型', '推理强度']);
  assert.doesNotMatch(JSON.stringify(rows), /bot-f4eb9bcb-844/);
  assert.deepEqual(plain(legacy.breed), { mode: 'explicit', breedId: 'bot-f4eb9bcb-844' });
  // No catalog, or a catalog entry without a name: nothing to name it by.
  assert.equal(breedRow(explicit('ragdoll'), {}), undefined);
  assert.equal(breedRow(explicit('ragdoll'), { breeds: [] }), undefined);
  assert.equal(breedRow(explicit('ragdoll'), { breeds: [{ id: 'ragdoll' }] }), undefined);
  assert.equal(breedRow({ breed: { mode: 'auto' }, runtimeId: 'claude', model: { mode: 'explicit', value: 'claude-opus-5-5' } }, {}), undefined);
});
