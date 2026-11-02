import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compileL0ViaSubprocess, clearL0Cache } from '../.runtime/clowder-ai/packages/api/dist/domains/cats/services/agents/providers/l0-compiler.js';

test('background policy preserves native identity and works on stdout, file and cached compilation without polluting the cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-policy-'));
  const previous = process.env.CAT_CAFE_BOT_BACKGROUND_DELEGATION;
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts/compile-system-prompt-l0.mjs'), '// isolated compiler fixture');
  const base = 'Original native identity, permissions and memory instructions.';
  let spawns = 0;
  const spawnFn = (_cmd, args) => {
    spawns++;
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    setImmediate(() => {
      const out = args.indexOf('--out');
      if (out >= 0) writeFileSync(args[out + 1], base);
      child.stdout.emit('data', Buffer.from(base)); child.emit('close', 0);
    });
    return child;
  };
  const options = { catId: 'policy-fixture', projection: 'public', cwd: dir, spawnFn };
  try {
    clearL0Cache(); delete process.env.CAT_CAFE_BOT_BACKGROUND_DELEGATION;
    assert.equal(await compileL0ViaSubprocess(options), base);
    const coldSpawns = spawns;
    process.env.CAT_CAFE_BOT_BACKGROUND_DELEGATION = '1';
    const outPath = join(dir, 'native-system.txt');
    const enabled = await compileL0ViaSubprocess({ ...options, outPath });
    assert.ok(enabled.startsWith(base + '\n\n'));
    assert.equal(enabled.match(/<bot_background_delegation>/g)?.length, 1);
    assert.equal(readFileSync(outPath, 'utf8'), enabled);
    assert.equal(spawns, coldSpawns, 'deployment policy must also apply on a native cache hit');
    assert.equal(await compileL0ViaSubprocess(options), enabled, 'resume must not duplicate instructions');
    delete process.env.CAT_CAFE_BOT_BACKGROUND_DELEGATION;
    assert.equal(await compileL0ViaSubprocess({ ...options, outPath }), base);
    assert.equal(readFileSync(outPath, 'utf8'), base, 'policy must not leak into the native cache');
  } finally {
    if (previous === undefined) delete process.env.CAT_CAFE_BOT_BACKGROUND_DELEGATION;
    else process.env.CAT_CAFE_BOT_BACKGROUND_DELEGATION = previous;
    clearL0Cache(); rmSync(dir, { recursive: true, force: true });
  }
});
