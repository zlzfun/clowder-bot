import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { ApiError } from '../server/errors.js';
import { NativeFixture } from './native-fixture.js';
import type { NativeCat } from '../server/native/types.js';

const config = {
  runtimeId: 'codex', breed: { mode: 'auto' }, model: { mode: 'explicit', value: 'gpt-6-astra' },
  effort: { mode: 'explicit', value: 'xhigh' }, portrait: { roleDescription: '检查配置', personality: '简洁', teamStrengths: '核对' },
};
const seed = { ...config, id: 'seed:maine-coon', name: '缅因猫', nameHint: '砚砚', revision: 7, source: { kind: 'native-seed', breedId: 'maine-coon', variantId: 'codex-default' } };
class TemplateFixture extends NativeFixture {
  template: any = seed;
  receipts = new Map<string, { payload: string; id: string }>();
  override async request<T>(path: string, options: { method?: string; body?: any; headers?: Record<string, string> } = {}): Promise<T> {
    if (path === '/api/cats' && options.method === 'POST' && options.headers?.['idempotency-key']) {
      this.calls.push({ path, method: 'POST', body: options.body });
      if (this.fail) throw this.fail;
      const key = options.headers['idempotency-key'], payload = JSON.stringify(options.body);
      const receipt = this.receipts.get(key);
      if (receipt) {
        if (receipt.payload !== payload) throw new ApiError(409, 'This creation request already belongs to a different configuration');
        return { cat: structuredClone(this.cats.find(c => c.id === receipt.id)) } as T;
      }
      const cat = { ...options.body, id: options.body.catId, breedId: options.body.breedId ?? options.body.catId, configurationRevision: 'r1' } as NativeCat;
      this.cats.push(cat);
      this.receipts.set(key, { payload, id: cat.id });
      return { cat: structuredClone(cat) } as T;
    }
    if (path.startsWith('/api/bot-cat-templates') || path === '/api/cats/runtime-models') {
      this.calls.push({ path, method: options.method || 'GET', body: options.body });
      if (this.fail) throw this.fail;
      if (path.endsWith('/instantiate')) {
        const c = options.body.catConfig;
        let cat = this.cats.find(c => c.id === 'native-template-cat');
        if (!cat) {
          cat = { id: 'native-template-cat', name: options.body.name, displayName: options.body.name, breedId: c.breed.breedId ?? 'moonshot',
            roleDescription: c.portrait.roleDescription, personality: c.portrait.personality, teamStrengths: c.portrait.teamStrengths,
            clientId: 'openai', configurationSource: 'native_tool', defaultModel: c.model.value ?? '', cli: { effort: c.effort.value },
            mentionPatterns: ['@test'], color: { primary: '#888', secondary: '#eee' } } as NativeCat;
          this.cats.push(cat);
        }
        const ref = options.body.sourceTemplate;
        return { cat, sourceTemplate: ref ? { ...ref, name: this.template.name } : null } as T;
      }
      if (path === '/api/cats/runtime-models') return { status: 'live', models: [{ value: 'gpt-6-astra', label: 'GPT', efforts: [{ value: 'xhigh', label: 'xhigh' }] }] } as T;
      if (options.method === 'DELETE') return { status: 'ok' } as T;
      if (path === '/api/bot-cat-templates' && (!options.method || options.method === 'GET')) {
        return { templates: [this.template], breeds: [{ id: 'maine-coon', name: '缅因猫' }, { id: 'dragon-li', name: '狸花猫', color: { primary: '#556677', secondary: '#ddeeff' } }] } as T;
      }
      return { template: this.template } as T;
    }
    return super.request(path, options);
  }
}
async function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'template-api-')), native = new TemplateFixture();
  const runtime = createApp({ native, dataFile: join(dir, 'presentation.json') });
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const call = (path: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  t.after(async () => { await runtime.close(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });
  return { ...runtime, native, call };
}

test('template CRUD forwards revisions to native storage without a product-side library', async t => {
  const r = await setup(t);
  assert.equal((await (await r.call('/xbot-api/cat-templates')).json()).templates[0].id, seed.id);
  assert.equal((await r.call('/xbot-api/cat-templates', 'POST', { ...config, name: '新模板', nameHint: '' })).status, 201);
  assert.equal((await r.call('/xbot-api/cat-templates/seed%3Amaine-coon', 'PUT', { ...config, name: seed.name, nameHint: '', expectedRevision: 7 })).status, 200);
  assert.equal(r.native.calls.at(-1)?.body.expectedRevision, 7);
  await r.call('/xbot-api/cat-templates/seed%3Amaine-coon', 'DELETE', { expectedRevision: 8 });
  assert.equal(r.native.calls.at(-1)?.path, '/api/bot-cat-templates/seed%3Amaine-coon');
  assert.equal(r.native.calls.at(-1)?.body.expectedRevision, 8);
  assert.equal('templates' in r.store.state, false);
  r.native.fail = new ApiError(409, '模板已更新');
  const conflict = await r.call('/xbot-api/cat-templates/seed%3Amaine-coon', 'PUT', {});
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, '模板已更新');
});

test('model capabilities are native discovery results; arbitrary launch inputs are rejected', async t => {
  const r = await setup(t), body = { model: 'gpt-6-astra', refresh: true };
  const response = await r.call('/xbot-api/agents/codex/models', 'POST', body);
  assert.equal(response.status, 200);
  assert.deepEqual(r.native.calls.at(-1)?.body, { runtimeId: 'codex', ...body });
  assert.equal((await response.json()).models[0].efforts[0].value, 'xhigh');
  assert.equal((await r.call('/xbot-api/agents/codex/models', 'POST', { command: '/arbitrary/program' })).status, 400);
});

test('list, detail and create use factory defaults independently of the machine model catalog', async t => {
  const r = await setup(t);
  // Revision emitted by P005 for this fixture. Real shipped seeds are covered by test:cat-templates-native.
  const stock = { ...seed, revision: 171891737033789, model: { mode: 'explicit', value: 'gpt-5.3-codex' } };
  r.native.template = stock;
  const list = await (await r.call('/xbot-api/cat-templates')).json();
  const { template } = await (await r.call('/xbot-api/cat-templates/seed%3Amaine-coon')).json();
  assert.deepEqual(template, list.templates[0]);
  assert.deepEqual(template, { ...stock, model: { mode: 'inherit' }, effort: { mode: 'inherit' },
    breed: { mode: 'explicit', breedId: 'maine-coon' } });
  assert.equal(r.native.calls.some(c => c.path === '/api/cats/runtime-models'), false);
  const { id, revision, name, nameHint, source, ...catConfig } = template;
  const body = { name: '跟随本机', catConfig, sourceTemplate: { id, revision }, idempotencyKey: randomUUID() };
  assert.equal((await r.call('/xbot-api/bots', 'POST', body)).status, 201);
  assert.deepEqual(r.native.calls.find(c => c.path.endsWith('/instantiate'))?.body, body);
  const detail = await (await r.call('/xbot-api/bots/跟随本机')).json();
  assert.deepEqual(detail.cat_config.model, { mode: 'inherit' });
  assert.deepEqual(detail.cat_config.effort, { mode: 'inherit' });

  r.native.template = { ...stock, revision: stock.revision + 1 };
  const edited = await (await r.call('/xbot-api/cat-templates')).json();
  assert.deepEqual(edited.templates[0], r.native.template, 'saved pins keep their native revision and values');
});

test('creation preserves request identity, native configuration and separate avatar/provenance IDs', async t => {
  const r = await setup(t), idempotencyKey = randomUUID();
  const body = { name: '配置猫', catConfig: config, sourceTemplate: { id: seed.id, revision: 7 }, idempotencyKey };
  const { idempotencyKey: omittedKey, ...withoutKey } = body;
  assert.equal((await r.call('/xbot-api/bots', 'POST', withoutKey)).status, 400, 'creation requires a client retry identity');
  assert.equal(r.native.calls.some(c => c.path.endsWith('/instantiate')), false);
  const response = await r.call('/xbot-api/bots', 'POST', body); assert.equal(response.status, 201);
  assert.deepEqual(r.native.calls.find(c => c.path.endsWith('/instantiate'))?.body, body);
  assert.equal((await r.call('/xbot-api/bots', 'POST', body)).status, 201, 'a replay goes back to native receipt handling');
  assert.equal(r.native.cats.length, 1);
  const meta = r.store.bot('native-template-cat');
  assert.equal(meta.templateId, 'turkish-van');
  assert.equal(meta.avatarSeed, 'cat:turkish-van');
  assert.equal(meta.sourceTemplate?.id, seed.id);
  assert.equal('catConfig' in meta, false);
  const detail = await (await r.call('/xbot-api/bots/配置猫')).json();
  assert.equal(detail.cat_config.model.value, 'gpt-6-astra');
  assert.equal(detail.cat_config.effort.value, 'xhigh');
  assert.equal(detail.source_template.id, seed.id);
  assert.equal((await r.call('/xbot-api/bots', 'POST', { ...body, runtimeId: 'codex' })).status, 400);
  assert.equal((await r.call('/xbot-api/bots', 'POST', { ...body, catConfig: { ...config, command: 'bad' } })).status, 400);
  assert.equal((await r.call('/xbot-api/bots/配置猫', 'PATCH', { catConfig: config })).status, 400);
});

test('OpenCode model lookup and template creation compose unpatched native endpoints cleanly', async t => {
  const r = await setup(t);
  assert.equal((await r.call('/xbot-api/agents/opencode/models', 'POST', {})).status, 404);
  r.native.availableClients = [{ client: 'opencode', label: 'OpenCode', cli: 'opencode', installed: false, authenticated: false }];
  const unavailable = await r.call('/xbot-api/agents/opencode/models', 'POST', {});
  assert.equal(unavailable.status, 200);
  assert.deepEqual(await unavailable.json(), { status: 'unavailable', models: [], message: 'not_installed' });

  r.native.availableClients = [{ client: 'opencode', label: 'OpenCode', cli: '/opt/homebrew/bin/opencode', installed: true, authenticated: true }];
  const configured = await r.call('/xbot-api/agents/opencode/models', 'POST', { refresh: true });
  assert.equal(configured.status, 200);
  assert.deepEqual(await configured.json(), { status: 'configured', models: [], effortOptions: [], defaultModelSource: 'tool_config', message: 'configured_only' });

  const ocTemplate = { ...seed, id: 'seed:dragon-li', name: '狸花猫', revision: 12, runtimeId: 'opencode', breed: { mode: 'explicit', breedId: 'dragon-li' }, model: { mode: 'inherit' }, effort: { mode: 'inherit' } };
  r.native.template = ocTemplate;
  const ocConfig = { runtimeId: 'opencode', breed: { mode: 'explicit', breedId: 'dragon-li' }, model: { mode: 'inherit' }, effort: { mode: 'inherit' }, portrait: { roleDescription: '写代码' } };
  assert.equal((await r.call('/xbot-api/bots', 'POST', { name: '错', catConfig: { ...ocConfig, effort: { mode: 'explicit', value: 'high' } }, idempotencyKey: randomUUID() })).status, 422);
  assert.equal((await r.call('/xbot-api/bots', 'POST', { name: '旧模板', catConfig: ocConfig, sourceTemplate: { id: ocTemplate.id, revision: 11 }, idempotencyKey: randomUUID() })).status, 409);

  const key = randomUUID();
  const body = { name: '小狸花', catConfig: ocConfig, sourceTemplate: { id: ocTemplate.id, revision: 12 }, idempotencyKey: key };
  const created = await r.call('/xbot-api/bots', 'POST', body);
  assert.equal(created.status, 201);
  assert.equal(r.native.calls.some(c => c.path.endsWith('/instantiate')), false);
  const postCat = r.native.calls.findLast(c => c.path === '/api/cats' && c.method === 'POST')!;
  assert.equal(postCat.body.clientId, 'opencode');
  assert.equal(postCat.body.breedId, 'dragon-li');
  assert.equal(postCat.body.defaultModel, '');
  assert.equal(postCat.body.cli.command, '/opt/homebrew/bin/opencode');
  assert.equal(postCat.body.cli.effort, null);

  // Source template edited later: identical idempotent retry still succeeds without rejecting.
  r.native.template = { ...ocTemplate, revision: 13 };
  assert.equal((await r.call('/xbot-api/bots', 'POST', body)).status, 201);
  assert.equal(r.native.cats.length, 1);

  // Lost response before store persistence + breed color change + template revision bump:
  // retry replays original payload (no 409) and records original template provenance (rev 12, not 13).
  const lostKey = randomUUID(), lostBody = { name: '小金渐层', catConfig: ocConfig, sourceTemplate: { id: ocTemplate.id, revision: 12 }, idempotencyKey: lostKey };
  r.native.template = ocTemplate;
  const origReq = r.native.request.bind(r.native);
  let dropNextPost = true;
  r.native.request = (async (path: string, opts?: any) => {
    if (path === '/api/bot-cat-templates' && (!opts?.method || opts.method === 'GET')) {
      return { templates: [r.native.template], breeds: [{ id: 'dragon-li', name: '狸花猫', color: { primary: dropNextPost ? '#556677' : '#112233', secondary: '#ddeeff' } }] };
    }
    const out = await origReq(path, opts);
    if (path === '/api/cats' && opts?.method === 'POST' && dropNextPost) {
      dropNextPost = false;
      throw new ApiError(503, 'lost answer');
    }
    return out;
  }) as typeof r.native.request;
  assert.equal((await r.call('/xbot-api/bots', 'POST', lostBody)).status, 503);
  r.native.template = { ...ocTemplate, revision: 13, name: '改名后的狸花猫' };
  const recovered = await r.call('/xbot-api/bots', 'POST', lostBody);
  assert.equal(recovered.status, 201);
  const lostCat = r.native.cats.find(c => c.name === '小金渐层')!;
  assert.deepEqual(r.store.bot(lostCat.id).sourceTemplate, { id: ocTemplate.id, revision: 12, name: '狸花猫' });

  // Concurrent creations with the same name must not create two cats with duplicate names.
  r.native.request = origReq;
  r.native.template = ocTemplate;
  const [c1, c2] = await Promise.all([
    r.call('/xbot-api/bots', 'POST', { name: '重名测试', catConfig: ocConfig, idempotencyKey: randomUUID() }),
    r.call('/xbot-api/bots', 'POST', { name: '重名测试', catConfig: ocConfig, idempotencyKey: randomUUID() }),
  ]);
  assert.deepEqual([c1.status, c2.status].sort(), [201, 409]);
  assert.equal(r.native.cats.filter(c => c.name === '重名测试').length, 1);
});
