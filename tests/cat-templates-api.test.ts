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
const seed = { ...config, id: 'seed:maine-coon', name: '缅因猫', nameHint: '砚砚', revision: 7, source: { kind: 'native-seed' } };
class TemplateFixture extends NativeFixture {
  override async request<T>(path: string, options: { method?: string; body?: any } = {}): Promise<T> {
    if (path.startsWith('/api/bot-cat-templates') || path === '/api/cats/runtime-models') {
      this.calls.push({ path, method: options.method || 'GET', body: options.body });
      if (this.fail) throw this.fail;
      if (path.endsWith('/instantiate')) {
        const c = options.body.catConfig;
        let cat = this.cats.find(c => c.id === 'native-template-cat');
        if (!cat) {
          cat = { id: 'native-template-cat', name: options.body.name, displayName: options.body.name, breedId: 'moonshot',
            roleDescription: c.portrait.roleDescription, personality: c.portrait.personality, teamStrengths: c.portrait.teamStrengths,
            clientId: 'openai', configurationSource: 'native_tool', defaultModel: c.model.value, cli: { effort: c.effort.value },
            mentionPatterns: ['@test'], color: { primary: '#888', secondary: '#eee' } } as NativeCat;
          this.cats.push(cat);
        }
        return { cat, sourceTemplate: { id: seed.id, revision: 7, name: seed.name } } as T;
      }
      if (path === '/api/cats/runtime-models') return { status: 'live', models: [{ value: 'gpt-6-astra', label: 'GPT', efforts: [{ value: 'xhigh', label: 'xhigh' }] }] } as T;
      if (options.method === 'DELETE') return { status: 'ok' } as T;
      if (path === '/api/bot-cat-templates' && (!options.method || options.method === 'GET')) return { templates: [seed], breeds: [{ id: 'maine-coon', name: '缅因猫' }] } as T;
      return { template: seed } as T;
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
