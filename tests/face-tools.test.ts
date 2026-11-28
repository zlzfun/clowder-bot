import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { catFaces, faceOfTool, faceTools } from '../server/native/agents.js';
import { catTemplates } from './native-fixture.js';

// Which tool a face's cat thinks with is the engine's knowledge (a breed's client in upstream's
// cat-template.json), but the engine's template API leaves it out, so the adapter keeps the pairing
// (server/native/agents.ts faceTools). This holds that copy, and the protocol fixture's templates,
// against the pinned upstream file, so an upgrade that changes a cat's tool or name is noticed here.
const file = resolve(import.meta.dirname, '../upstream/clowder-ai/cat-template.json');
// The ids the engine's local tool detection gives the tools of a client (routes/cats.ts native-runtimes in the pinned upstream).
const runtimesOfClient: Record<string, string[]> = { anthropic: ['claude'], openai: ['codex'], google: ['agy-native', 'agy-acp'], kimi: ['kimi'], opencode: ['opencode'], antigravity: ['antigravity'] };

test('each face is paired with the tool its cat has in the pinned engine', { skip: !existsSync(file) && 'the upstream submodule is not checked out' }, () => {
  const upstream = JSON.parse(readFileSync(file, 'utf8')) as { roleTemplates: Array<Record<string, any>>; breeds: Array<Record<string, any>> };
  assert.deepEqual(upstream.roleTemplates.map(template => template.id), [...catFaces], 'the faces are the engine’s templates, in its order');
  for (const face of catFaces) {
    const template = upstream.roleTemplates.find(entry => entry.id === face)!;
    // A template and its breed share the cat's name (梵花猫's breed is called moonshot upstream); 小鲸鱼 has no breed entry: it is the cat of the DSH runtime.
    const breed = upstream.breeds.find(entry => entry.id === face) ?? upstream.breeds.find(entry => entry.name === template.name);
    if (!breed) { assert.equal(face, 'dsh'); assert.deepEqual(faceTools[face], { runtimes: ['dsh'], label: 'DSH' }); continue; }
    const variant = breed.variants.find((entry: any) => entry.id === breed.defaultVariantId) ?? breed.variants[0];
    assert.equal(faceTools[face].client, variant.clientId, `${template.name} runs on ${variant.clientId} upstream`);
    assert.deepEqual(faceTools[face].runtimes, runtimesOfClient[variant.clientId]);
  }
  // The tools the app can connect each lead back to one cat; so does a member the engine runs over ACP, by its client.
  assert.deepEqual(['claude', 'codex', 'kimi', 'opencode'].map(id => faceOfTool({ id, label: id, clientId: '', installed: true, models: [] })), ['ragdoll', 'maine-coon', 'turkish-van', 'dragon-li']);
  assert.deepEqual([faceOfTool({ id: 'acp:gemini', label: 'x', clientId: 'google', installed: true, models: [] }), faceOfTool({ id: 'acp:other', label: 'x', clientId: 'unknown', installed: true, models: [] })], ['siamese', undefined]);
  // The protocol fixture serves these same templates, word for word.
  assert.deepEqual(catTemplates, upstream.roleTemplates.map(t => [t.id, t.name, t.roleDescription, t.personality, t.teamStrengths, t.nickname]));
});
