import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain module without types
import { frontendStale, launchPlan } from '../scripts/app-plan.mjs';

const fresh = { bot: 'free', native: 'free', busy: [], ports: { bot: 3210, native: 4331 }, runtimeBuilt: false, frontendBuilt: false, frontendStale: true, build: true };

test('a fresh checkout prepares the runtime, builds the page, then starts the engine before the app', () => {
  assert.deepEqual(launchPlan(fresh), { action: 'run', steps: ['prepare', 'build', 'native', 'bot'] });
});

test('later starts skip what is already there', () => {
  assert.deepEqual(launchPlan({ ...fresh, runtimeBuilt: true, frontendBuilt: true, frontendStale: false }), { action: 'run', steps: ['native', 'bot'] });
  assert.deepEqual(launchPlan({ ...fresh, runtimeBuilt: true, frontendBuilt: true, frontendStale: true }), { action: 'run', steps: ['build', 'native', 'bot'] }, 'the page is rebuilt after an update');
  assert.deepEqual(launchPlan({ ...fresh, runtimeBuilt: true, frontendBuilt: true, frontendStale: true, build: false }), { action: 'run', steps: ['native', 'bot'] }, '--no-build keeps the page that is there');
});

test('an instance that is already running is only opened, never rebuilt under itself', () => {
  assert.deepEqual(launchPlan({ ...fresh, bot: 'ours', native: 'ours' }), { action: 'open' });
  assert.deepEqual(launchPlan({ ...fresh, bot: 'ours', native: 'ours', busy: [6392, 9492], frontendStale: true }), { action: 'open' });
});

test('an engine started separately only gets the app added', () => {
  assert.deepEqual(launchPlan({ ...fresh, native: 'ours', busy: [6392, 9492], runtimeBuilt: true, frontendBuilt: true, frontendStale: false }), { action: 'run', steps: ['bot'] });
  assert.deepEqual(launchPlan({ ...fresh, native: 'ours', busy: [6392], runtimeBuilt: true }), { action: 'run', steps: ['build', 'bot'] });
});

test('ports held by something else stop the start with the port named, before anything is built', () => {
  for (const [state, port] of [[{ bot: 'other' }, '3210'], [{ native: 'other' }, '4331'], [{ busy: [6392] }, '6392']] as const) {
    const plan = launchPlan({ ...fresh, ...state });
    assert.equal(plan.action, 'stop'); assert.match(plan.reason, new RegExp(port));
  }
});

test('--no-build cannot start an app whose page was never built', () => {
  const plan = launchPlan({ ...fresh, runtimeBuilt: true, build: false });
  assert.equal(plan.action, 'stop'); assert.match(plan.reason, /--no-build/);
});

test('the page is stale when it was never built or any source is newer', () => {
  assert.equal(frontendStale([10, 20], undefined), true);
  assert.equal(frontendStale([10, 20], 15), true);
  assert.equal(frontendStale([10, 20], 20), false);
});
