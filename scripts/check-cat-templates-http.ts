import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = `http://127.0.0.1:${process.env.PORT || 3210}`;
const suffix = randomUUID().slice(0, 8), catName = `模板验收-${suffix}`;
let custom: any, created = false;
async function call(path: string, method = 'GET', body?: unknown, expected = 200) {
  const response = await fetch(base + path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000) });
  const data = await response.json() as any;
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}
const editable = ({ id, revision, source, ...body }: any) => structuredClone(body);
const configuration = ({ name, nameHint, ...body }: any) => body;
try {
  const library = await call('/xbot-api/cat-templates');
  const defaults = library.templates.filter((t: any) => t.source.kind === 'native-seed');
  // Existing user deletions/overrides are preserved; do not reset the library for a test.
  assert.equal(new Set(defaults.map((t: any) => t.source.breedId)).size, defaults.length);
  const seed = defaults.find((t: any) => t.source.breedId === 'ragdoll');
  assert.ok(seed, 'This check needs the ragdoll seed; never restores a user-deleted seed automatically');
  assert.equal(seed.runtimeId, 'claude');
  custom = (await call('/xbot-api/cat-templates', 'POST', {
    ...editable(seed), name: `模板测试-${suffix}`, nameHint: '',
    model: { mode: 'explicit', value: 'claude-opus-5-5' }, effort: { mode: 'explicit', value: 'xhigh' },
  }, 201)).template;
  const first = structuredClone(custom);
  custom = (await call(`/xbot-api/cat-templates/${encodeURIComponent(custom.id)}`, 'PUT', {
    ...editable(custom), portrait: { ...custom.portrait, roleDescription: '模板配置验收，不启动执行。' }, expectedRevision: custom.revision,
  })).template;
  await call(`/xbot-api/cat-templates/${encodeURIComponent(custom.id)}`, 'PUT', { ...editable(first), expectedRevision: first.revision }, 409);
  const catConfig = configuration(editable(custom)); catConfig.portrait.personality = '实例独立的性格';
  const creation = { name: catName, catConfig, sourceTemplate: { id: custom.id, revision: custom.revision }, idempotencyKey: randomUUID() };
  const result = await call('/xbot-api/bots', 'POST', creation, 201); created = true;
  const repeated = await call('/xbot-api/bots', 'POST', creation, 201);
  assert.equal(repeated.native_id, result.native_id);
  const member = async () => (await call('/native-api/api/cats')).cats.find((c: any) => c.id === result.native_id);
  const cat = await member();
  assert.equal(cat.breedId, 'ragdoll');
  assert.equal(cat.defaultModel, 'claude-opus-5-5');
  assert.equal(cat.cli.effort, 'xhigh');
  assert.equal(cat.personality, '实例独立的性格');
  assert.equal((await call('/xbot-api/bots')).bots.filter((c: any) => c.name === catName).length, 1);
  custom = (await call(`/xbot-api/cat-templates/${encodeURIComponent(custom.id)}`, 'PUT', {
    ...editable(custom), portrait: { ...custom.portrait, roleDescription: '只供之后创建使用的新画像' }, expectedRevision: custom.revision,
  })).template;
  assert.equal((await member()).roleDescription, cat.roleDescription);
  await call(`/xbot-api/cat-templates/${encodeURIComponent(custom.id)}`, 'DELETE', { expectedRevision: custom.revision });
  custom = null;
  assert.equal((await member()).defaultModel, cat.defaultModel);
  assert.equal((await call('/xbot-api/bots', 'POST', creation, 201)).native_id, result.native_id, 'retry still resolves after the source template was deleted');
  await call('/xbot-api/bots', 'POST', { ...creation, name: catName + '-changed' }, 409);
  const statuses = await call('/xbot-api/bots/status');
  const status = statuses.bots.find((b: any) => b.native_id === result.native_id);
  assert.equal(status.active.length, 0); assert.equal(status.queued.length, 0);
  console.log('Native template CRUD, revision conflict, independent cat snapshot, family mapping, model/effort and idempotent retry verified. No execution started.');
} finally {
  if (created) await call(`/xbot-api/bots/${encodeURIComponent(catName)}`, 'DELETE');
  if (custom) await call(`/xbot-api/cat-templates/${encodeURIComponent(custom.id)}`, 'DELETE', { expectedRevision: custom.revision });
}
