const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');

// Load without creating logs or user data in either application's real directory.
function loadManager() {
  const filename = path.join(__dirname, 'service-manager.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const safeFs = { ...fs, mkdirSync() {}, appendFileSync() {} };
  vm.runInNewContext(
    fs.readFileSync(filename, 'utf8'),
    {
      require: (name) => (name === 'node:fs' ? safeFs : localRequire(name)),
      module,
      exports: module.exports,
      __dirname,
      process,
      Buffer,
      setTimeout,
      clearTimeout,
    },
    { filename },
  );
  return module.exports;
}
const ServiceManager = loadManager();
function manager() {
  return new ServiceManager(path.resolve(__dirname, '..'), {
    frontendPort: 5194,
    apiPort: 3194,
    redisPort: 6306,
    isolated: true,
  });
}

test('isolated desktop refuses an occupied Redis port without borrowing a responding instance', async () => {
  const subject = manager();
  const checked = [];
  subject._isPortOpen = async (port) => {
    checked.push(port);
    return true;
  };
  subject._verifyRedisPing = async () => assert.fail('must not authenticate a foreign service by PING');
  await assert.rejects(subject._startRedis('/private/tmp/bot-isolation-fixture'), /occupied|占用/);
  assert.deepEqual(checked, [6306]);
  assert.equal(subject.memoryMode, false);
});

test('isolated desktop fails when durable storage is unavailable instead of accepting volatile conversations', async () => {
  const subject = manager();
  subject._isPortOpen = async () => false;
  subject._commandExists = async () => false;
  await assert.rejects(subject._startRedis('/private/tmp/bot-isolation-fixture'), /Redis|storage/);
  assert.equal(subject.memoryMode, false);
});

test('isolated Redis is loopback-only, persistent and launched on the dedicated port', async () => {
  const subject = manager();
  subject._isPortOpen = async () => false;
  subject._commandExists = async () => true;
  let launch;
  subject._startProcess = (name, command, args) => {
    launch = { name, command, args };
  };
  subject._waitForPortWithFallback = async (port) => {
    assert.equal(port, 6306);
    return true;
  };
  await subject._startRedis('/private/tmp/bot-isolation-fixture');
  assert.equal(launch.name, 'redis');
  assert.equal(launch.args[launch.args.indexOf('--port') + 1], '6306');
  assert.equal(launch.args[launch.args.indexOf('--bind') + 1], '127.0.0.1');
  assert.equal(launch.args[launch.args.indexOf('--appendonly') + 1], 'yes');
  assert.equal(launch.args[launch.args.indexOf('--dir') + 1], '/private/tmp/bot-isolation-fixture/data/redis');
});

test('normal isolated quit lets API/plugin shutdown finish before stopping persistent Redis', async () => {
  const subject = manager();
  subject.procs = Object.fromEntries(
    ['redis', 'api', 'web'].map((name, index) => [
      name,
      {
        pid: index + 10,
        killed: false,
        exitCode: null,
        signalCode: null,
      },
    ]),
  );
  const transitions = [];
  subject._killProcessTree = async (name) => {
    transitions.push(`stop:${name}`);
    await new Promise((resolve) => setImmediate(resolve));
    transitions.push(`exit:${name}`);
  };
  await subject.stopAll();
  assert.deepEqual(transitions, ['stop:web', 'exit:web', 'stop:api', 'exit:api', 'stop:redis', 'exit:redis']);
  assert.deepEqual(Object.keys(subject.procs), []);
});

test('isolated child environment rejects inherited host configuration and memory mode', () => {
  const subject = manager();
  const env = subject._buildProcessEnv({
    HOME: '/users/owner',
    PATH: '/usr/bin',
    MEMORY_STORE: '1',
    REDIS_URL: 'redis://foreign',
    CAT_TEMPLATE_PATH: '/original/template.json',
    CAT_CAFE_DATA_DIR: '/original/data',
    NODE_OPTIONS: '--require foreign',
    CAT_CAFE_CALLBACK_TOKEN: 'foreign',
  });
  assert.equal(env.HOME, '/users/owner');
  assert.equal(env.REDIS_URL, 'redis://127.0.0.1:6306');
  assert.equal(env.API_SERVER_PORT, '3194');
  for (const key of [
    'MEMORY_STORE',
    'CAT_TEMPLATE_PATH',
    'CAT_CAFE_DATA_DIR',
    'NODE_OPTIONS',
    'CAT_CAFE_CALLBACK_TOKEN',
  ])
    assert.equal(env[key], undefined);
  subject._getOrCreateTelemetrySalt = () => 'fixture';
  const paths = subject._buildApiEnv('/private/tmp/bot-isolation-fixture');
  assert.equal(paths.CAT_CAFE_GLOBAL_CONFIG_ROOT, '/private/tmp/bot-isolation-fixture/config');
  assert.equal(paths.CAT_CAFE_SKIP_HOMEDIR_MIGRATION, '1');
});

test('quit is idempotent and prevents any later child spawn during startup', async () => {
  const subject = manager();
  const first = subject.stopAll();
  assert.equal(first, subject.stopAll());
  await first;
  assert.throws(() => subject._startProcess('api', '/never-run', []), /stopping/);
});

test('runtime identity and data root remain separate without electron-builder metadata', () => {
  const identity = require('./app-identity');
  assert.equal(identity.DESKTOP_APP_ID, 'ai.clowderbot.desktop');
  assert.equal(path.basename(ServiceManager.USER_DATA_DIR), 'Clowder Bot');
});

for (const [method, name] of [
  ['_waitForPort', 'api'],
  ['_waitForHttpReady', 'web'],
  ['_waitForPortWithFallback', 'redis'],
]) {
  test(`${name} refuses foreign readiness when its own child has already exited`, async () => {
    const subject = manager();
    subject.procs[name] = { pid: 1234, exitCode: 1, signalCode: null };
    subject._isPortOpen = async () => true;
    subject._isHttpReady = async () => true;
    await assert.rejects(subject[method](6306, name, name), /exited|owned/);
  });
}

test('a listening socket must belong to the owned child before isolated readiness succeeds', async () => {
  const subject = manager();
  subject.procs.api = { pid: 1234, exitCode: null, signalCode: null };
  subject._isPortOpen = async () => true;
  subject._ownsListeningPort = () => false;
  await assert.rejects(subject._waitForPort(3194, 'API'), /ownership|owned/);
});
