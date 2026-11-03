import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { root, lock } from './upstream-source.mjs';

const api = resolve(root, lock.build, 'packages/api/dist');
const { BotCatTemplateStore, botCatTemplateSeeds, mergeBotCatTemplateSource, inferBotCatBreed } = await import(pathToFileURL(
  process.env.BOT_TEMPLATE_TEST_MODULE || resolve(api, 'config/bot-cat-templates.js')));
const { withRuntimeCatMutationLock } = await import(pathToFileURL(resolve(api, 'config/runtime-cat-catalog.js')));
const shipped = JSON.parse(readFileSync(resolve(root, lock.source, 'cat-template.json'), 'utf8'));
const inputOf = ({ id, revision, source, ...input }) => structuredClone(input);
const create = t => {
  const dir = mkdtempSync(join(tmpdir(), 'clowder-template-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new BotCatTemplateStore(dir, () => shipped) };
};

test('one shipped default per cat identity, including legacy empty bootstrap projects', () => {
  const original = structuredClone(shipped);
  const { templates, breeds } = botCatTemplateSeeds(mergeBotCatTemplateSource(shipped, { version: 2, breeds: [], roster: {} }));
  assert.equal(templates.length, 8);
  assert.equal(new Set(templates.map(t => t.source.breedId)).size, 8);
  assert.deepEqual(breeds.map(b => b.id), ['ragdoll', 'maine-coon', 'siamese', 'moonshot', 'dsh', 'dragon-li', 'bengal', 'golden-chinchilla']);
  const ragdoll = templates.find(t => t.id === 'seed:ragdoll');
  assert.equal(ragdoll.runtimeId, 'claude');
  assert.equal(ragdoll.model.value, 'claude-opus-4-6');
  assert.equal(ragdoll.effort.value, 'max');
  assert.equal(templates.find(t => t.id === 'seed:maine-coon').runtimeId, 'codex');
  assert.equal(templates.find(t => t.id === 'seed:dsh').runtimeId, null);
  assert.equal(templates.find(t => t.id === 'seed:bengal').breed.mode, 'explicit');
  assert.deepEqual(shipped, original, 'seeding cannot mutate the native template');
});

test('user overrides and deletion tombstones survive reopening; same-breed custom templates remain independent', async t => {
  const { dir, store } = create(t), seed = store.get('seed:ragdoll');
  const input = inputOf(seed); input.model = { mode: 'explicit', value: 'claude-opus-5-5' };
  const updated = await withRuntimeCatMutationLock(dir, () => store.save(input, seed.id, seed.revision));
  assert.equal(updated.revision, seed.revision + 1);
  const reopened = new BotCatTemplateStore(dir, () => shipped);
  assert.equal(reopened.get(seed.id).model.value, 'claude-opus-5-5');
  const custom = await withRuntimeCatMutationLock(dir, () => reopened.save({ ...input, name: '自己的布偶猫' }));
  assert.notEqual(custom.id, seed.id);
  await withRuntimeCatMutationLock(dir, () => reopened.remove(seed.id, updated.revision));
  const final = new BotCatTemplateStore(dir, () => shipped);
  assert.throws(() => final.get(seed.id), e => e.status === 404);
  assert.equal(final.get(custom.id).name, '自己的布偶猫');
  assert.equal(final.list().templates.length, 8);
});

test('parallel writes with one revision cannot silently overwrite each other', async t => {
  const { dir, store } = create(t), seed = store.get('seed:ragdoll'), input = inputOf(seed);
  const results = await Promise.allSettled(['A', 'B'].map(name => withRuntimeCatMutationLock(dir, () => store.save({ ...input, name }, seed.id, seed.revision))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  assert.throws(() => store.remove(seed.id, seed.revision), e => e.status === 409);
});

test('creation reservation freezes a snapshot, survives template deletion and rejects changed retries', async t => {
  const { dir, store } = create(t), seed = store.get('seed:ragdoll');
  const { name, nameHint, ...catConfig } = inputOf(seed);
  const input = { name: '一只猫', catConfig, sourceTemplate: { id: seed.id, revision: seed.revision }, idempotencyKey: randomUUID() };
  const payload = { catId: 'test-cat', defaultModel: catConfig.model.value, roleDescription: catConfig.portrait.roleDescription };
  await withRuntimeCatMutationLock(dir, () => store.reserve(input, payload));
  await withRuntimeCatMutationLock(dir, () => store.remove(seed.id, seed.revision));
  const reopened = new BotCatTemplateStore(dir, () => shipped);
  assert.deepEqual(reopened.previous(input).payload, payload);
  assert.deepEqual(reopened.reserve(input, { defaultModel: 'different' }).payload, payload);
  assert.throws(() => reopened.previous({ ...input, name: '改变了名字' }), e => e.status === 409);
  assert.throws(() => reopened.reserve({ ...input, idempotencyKey: randomUUID() }, payload), e => e.status === 409);
});

test('corrupted saved state is reported, never replaced with fresh defaults', t => {
  const { store } = create(t), seed = store.get('seed:ragdoll');
  store.save(inputOf(seed));
  writeFileSync(store.file, '{broken');
  assert.throws(() => store.list());
  assert.throws(() => store.save(inputOf(seed)));
  assert.equal(readFileSync(store.file, 'utf8'), '{broken');
});

test('model family identity survives subseries and version changes; unknown models need explicit identity', () => {
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5', 'opus', 'fable']) assert.equal(inferBotCatBreed(model), 'ragdoll');
  for (const model of ['gpt-6-astra', 'gpt-5.4', 'gpt-5.3-codex']) assert.equal(inferBotCatBreed(model), 'maine-coon');
  assert.equal(inferBotCatBreed('kimi-code/kimi-for-coding'), 'moonshot');
  assert.equal(inferBotCatBreed('zhipu/glm-5.2'), 'dragon-li');
  assert.equal(inferBotCatBreed('deepseek-v4'), 'dsh');
  assert.equal(inferBotCatBreed('o9'), null);
  assert.equal(inferBotCatBreed('claude-gpt-6'), null);
  assert.equal(inferBotCatBreed('unknown-provider/model'), null);
});
