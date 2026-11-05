import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { root, lock } from './upstream-source.mjs';

const checks = new Set(['test-background-output.mjs', 'test-task-background.mjs', 'test-native-mcp-bridge.mjs', 'check-task-background-sdk.mjs', 'test-workspace-history.mjs']);
const check = process.argv[2];
if (!checks.has(check)) throw new Error('Unknown native regression check');
const api = resolve(root, process.env.BOT_TASK_TEST_RUNTIME || lock.build, 'packages/api');
const result = spawnSync(process.execPath, [
  resolve(api, 'scripts/with-test-home.mjs'), '--env', 'CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1',
  process.execPath, '--import', resolve(api, 'test/helpers/setup-cat-registry.js'), ...(check.startsWith('test-') ? ['--test'] : []), resolve(root, 'scripts', check),
], { cwd: api, env: process.env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
