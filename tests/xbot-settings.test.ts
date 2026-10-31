import test from 'node:test';
import assert from 'node:assert/strict';
import express, { type ErrorRequestHandler } from 'express';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { ApiError, Orchestrator } from '../server/orchestrator.js';
import { createXbotSettingsRouter, applyBotPersona, personaCardSummary, resolveXbotBinding } from '../server/xbot/settings.js';

test('original xbot support APIs persist cards, bind portraits, protect secrets and reject unsupported mutations', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'clowder-xbot-settings-'));
  const envName = 'CLOWDER_XBOT_SETTINGS_TEST_KEY';
  const original = process.env[envName]; delete process.env[envName];
  const store = new Store(join(dir, 'state.json'));
  store.state.settings.apiKeyEnv = envName;
  const orchestrator = new Orchestrator(store);
  let catalogFetches = 0;
  const app = express(); app.use(express.json());
  app.use('/xbot-api', createXbotSettingsRouter(store, orchestrator, { fetcher: async (url, init) => {
    catalogFetches++;
    assert.equal(String(url), 'https://api.openai.com/v1/models');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-private-api-key');
    return new Response(JSON.stringify({ data: [{ id: 'model-test' }, { id: 'text-embedding-test' }] }));
  } }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => res.status(error instanceof ApiError ? error.status : 400).json({ error: error.message });
  app.use(errors);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/xbot-api`;
  t.after(async () => {
    await new Promise<void>(done => server.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
    if (original === undefined) delete process.env[envName]; else process.env[envName] = original;
  });
  const call = (method: string, path: string, body?: unknown) => fetch(base + path, { method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = async (path: string) => (await call('GET', path)).json() as Promise<any>;

  const initial = await data('/providers');
  assert.deepEqual(initial.providers.map((row: any) => row.name), ['demo', 'openai', 'claude-cli', 'codex-cli', 'gemini-cli']);
  assert.equal(initial.providers.find((row: any) => row.name === 'openai').key_configured, false);
  assert.equal((await call('PUT', '/providers/openai/key', { key: 'test-private-api-key' })).status, 200);
  assert.equal(statSync(join(dir, 'provider-secrets.json')).mode & 0o777, 0o600);
  assert.ok(!readFileSync(store.file, 'utf8').includes('test-private-api-key'));
  assert.equal((await data('/providers')).providers.find((row: any) => row.name === 'openai').key_configured, true);
  const catalog = await data('/providers/models?provider=openai');
  assert.deepEqual(catalog.models.map((row: any) => row.model), ['model-test']);
  assert.equal(catalogFetches, 1);
  assert.ok(!(JSON.stringify(await data('/providers'))).includes('test-private-api-key'));
  assert.deepEqual(resolveXbotBinding(store, 'claude-cli', 'default'), { provider: 'claude-cli', model: '' });
  assert.throws(() => resolveXbotBinding(store, 'anthropic', 'claude'), /尚未接入/);

  const seeds = (await data('/persona-cards')).cards;
  assert.equal(seeds.length, 8);
  assert.ok(seeds.some((row: any) => row.name.includes('布偶猫')));
  assert.equal(personaCardSummary(store, store.state.bots[0]!)?.id, 'cat-ragdoll');
  assert.equal((await call('DELETE', '/persona-cards/cat-ragdoll')).status, 400);
  assert.equal((await call('PUT', '/persona-cards/cat-ragdoll', { body: '新版架构伙伴，先给结论。' })).status, 200);
  assert.equal(store.state.bots[0]!.persona, '新版架构伙伴，先给结论。');
  const created = await (await call('POST', '/persona-cards', { name: '简短回答', body: '总是用两句回答。' })).json() as any;
  const bot = store.state.bots[0]!;
  assert.equal((await call('PUT', `/bots/${encodeURIComponent(bot.name)}/persona-card`, { id: created.id })).status, 200);
  assert.ok(bot.persona.includes('总是用两句回答。'));
  const before = bot.persona; applyBotPersona(store, bot); assert.equal(bot.persona, before);
  assert.equal((await data(`/persona-cards/${created.id}`)).bots, 1);
  assert.equal((await call('PUT', `/persona-cards/${created.id}`, { body: '总是用三句回答。' })).status, 200);
  assert.ok(bot.persona.includes('总是用三句回答。'));
  assert.ok(!bot.persona.includes('总是用两句回答。'));
  assert.equal((await call('DELETE', `/persona-cards/${created.id}`)).status, 409);
  assert.equal((await call('DELETE', `/persona-cards/${created.id}?force=1`)).status, 200);
  assert.equal(personaCardSummary(store, bot)?.id, 'cat-ragdoll');
  const imported = await call('POST', '/persona-cards/import', { filename: 'writer.md', content: '# 写作伙伴\n精简清晰。' });
  assert.equal(imported.status, 200);
  assert.equal((await call('POST', '/persona-cards/import', { filename: 'writer.md', content: '# 写作伙伴\n精简清晰。' })).status, 409);
  const duplicate = await (await call('POST', '/persona-cards/import', { filename: 'writer.md', content: '# 写作伙伴\n精简清晰。', confirm: true })).json() as any;
  assert.equal(duplicate.name, '写作伙伴 (2)');
  const restored = new Store(store.file);
  assert.ok(restored.xbot.personaCards.some((row: any) => row.name === '写作伙伴 (2)'));
  assert.equal((await data('/account/me')).account.owner, true);
  for (const path of ['/web-search', '/image-gen', '/apps', '/skills', '/push', '/permissions', '/devices']) {
    assert.equal((await data(path)).supported, false);
  }
  for (const [method, path, body] of [['PUT', '/web-search', { enabled: true }], ['POST', '/apps', { id: 'slack' }],
    ['PUT', '/permissions', { confirm: 'table' }], ['POST', '/push/subscribe', {}], ['POST', '/account/logout', {}],
    ['PUT', '/providers/deepseek/key', { key: 'test-private-api-key' }]] as const) {
    assert.equal((await call(method, path, body)).status, 501, path);
  }
});
