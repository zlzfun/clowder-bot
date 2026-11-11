import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { catTemplates } from './native-fixture.js';

// `npm run showcase` (scripts/showcase-scene.ts) is read by the real adapter: when a projection changes,
// a staged chat can quietly stop showing what it is there to show. This starts it and looks at each one.
const root = resolve(import.meta.dirname, '..');
const freePort = () => new Promise<number>((done, fail) => {
  const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); });
});

test('the showcase stages one cat per template, and each chat shows what it is there for', async t => {
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/preview-fixture.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PREVIEW_PORT: String(port), PREVIEW_SCENE: 'showcase' } });
  t.after(() => { child.kill('SIGTERM'); });
  let output = '';
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('the showcase did not start:\n' + output)), 30_000);
    const read = (chunk: Buffer) => { output += chunk; if (/showcase \(staged chats/.test(output)) { clearTimeout(timer); done(); } };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.once('exit', code => { clearTimeout(timer); fail(new Error(`the showcase exited (${code}):\n${output}`)); });
  });
  const get = async (path: string) => { const response = await fetch(base + path); assert.equal(response.status, 200, path); return response.json() as Promise<any>; };
  const chat = (name: string) => `/xbot-api/bots/${encodeURIComponent(name)}`;

  // The cats are the engine's templates: its name, its face, its colour.
  const { bots } = await get('/xbot-api/bots');
  assert.deepEqual(bots.map((bot: any) => [bot.templateId, bot.name]), catTemplates.map(([id, name]) => [id, name]));
  assert.ok(bots.every((bot: any) => bot.avatar_seed === `cat:${bot.templateId}` && /^#[0-9A-F]{6}$/i.test(bot.accent?.primary)));
  assert.equal(new Set(bots.map((bot: any) => bot.accent.primary)).size, 8);
  assert.deepEqual(bots.filter((bot: any) => bot.pinned).map((bot: any) => bot.name), ['布偶猫']);

  const { groups } = await get('/xbot-api/groups');
  assert.deepEqual(groups.map((group: any) => [group.name, group.members.length]), [['产品评审', 3], ['读书会', 4]]);

  // The contact list: two requests waiting, unread only where the scene left something unread.
  const status = await get('/xbot-api/bots/status'), row = (name: string) => status.bots.find((bot: any) => bot.bot === name);
  assert.deepEqual(status.bots.filter((bot: any) => bot.state === 'awaiting').map((bot: any) => bot.bot), ['小鲸鱼', '狸花猫']);
  assert.deepEqual(status.bots.map((bot: any) => bot.unread), [0, 0, 0, 0, 2, 0, 0, 0]);
  assert.deepEqual(status.groups.map((group: any) => group.activity.unread), [3, 0]);
  assert.match(row('小鲸鱼').activity.last.text, /^想设一个定时：写周报 · 每周五 17:00/);
  assert.deepEqual([row('梵花猫').activity.last.text, row('梵花猫').activity.last.files], ['', 1]);
  assert.ok(status.bots.every((bot: any) => bot.activity.readStatus === 'ready' && bot.activity.last));

  // Each chat's own ability, as the adapter projects it.
  const rows = async (name: string) => (await get(`${chat(name)}/transcript`)).messages.filter((message: any) => message.role !== 'tool');
  const kinds = (messages: any[]) => messages.flatMap(message => (message.blocks ?? []).map((block: any) => block.kind));
  assert.ok((await rows('布偶猫')).some((message: any) => message.ended?.how === 'stopped'));
  assert.deepEqual(kinds(await rows('缅因猫')), ['card', 'checklist', 'diff', 'checklist']);
  const siamese = await rows('暹罗猫');
  assert.deepEqual(siamese.flatMap((message: any) => (message.blocks ?? []).map((block: any) => [block.mode, block.answered])), [['single', true], ['multiple', false]]);
  assert.deepEqual(siamese.flatMap((message: any) => message.attachments.map((file: any) => [file.name, file.mime, file.availability])), [['首页配色稿.png', 'image/png', 'available']]);
  const van = await rows('梵花猫');
  assert.deepEqual(van.flatMap((message: any) => message.attachments.map((file: any) => [file.name, file.kind])), [['周会记录.txt', 'attachment'], ['周会纪要.md', 'deliverable'], ['待办清单.md', 'deliverable']]);
  assert.equal((await get(`${chat('梵花猫')}/files`)).files.length, 3);
  const whale = await rows('小鲸鱼');
  assert.deepEqual(whale.filter((message: any) => message.reminder).map((message: any) => message.content), ['提醒：看一眼当天的日程', '提醒：看一眼当天的日程']);
  assert.deepEqual(whale.flatMap((message: any) => (message.blocks ?? []).map((block: any) => block.approval?.state ?? 'open')), ['approved', 'open']);
  assert.deepEqual((await get(`${chat('小鲸鱼')}/approvals`)).approvals.map((item: any) => [item.kind, item.body, item.approve?.label]), [['schedule', '写周报 · 每周五 17:00（Asia/Shanghai）', '设上']]);
  assert.deepEqual((await get(`${chat('小鲸鱼')}/routines`)).routines.map((routine: any) => [routine.name, routine.status, routine.runStats.delivered]), [['看当天的日程', 'scheduled', 2]]);
  assert.deepEqual((await get(`${chat('狸花猫')}/approvals`)).approvals.map((item: any) => [item.kind, item.body]), [['preference', '引用资料时带上出处']]);
  assert.deepEqual((await get('/xbot-api/memory/taste')).entries.map((entry: any) => entry.content.split('\n')[0]), ['回答时先说结论，再给依据']);
  assert.equal((await get('/xbot-api/memory/profile')).entries.length, 1);
  const bengal = await rows('孟加拉猫');
  assert.deepEqual(bengal.filter((message: any) => message.ended).map((message: any) => message.ended.how), ['failed', 'interrupted']);
  assert.equal(bengal.at(-1).blocks_hidden, 1);
  // 金渐层 is read ten messages at a time and keeps an earlier conversation.
  const gold = await get(`${chat('金渐层')}/transcript`);
  assert.equal(gold.hasMore, true);
  // The owner's last question quotes an answer from an earlier page; the quote is drawn once that page has been read.
  await get(`${chat('金渐层')}/transcript?before=${encodeURIComponent(gold.before)}`);
  assert.ok((await rows('金渐层')).some((message: any) => message.role === 'user' && message.reply_to > 0));
  assert.equal((await get(`${chat('金渐层')}/conversations`)).conversations.length, 2);
  const review = await get(`/xbot-api/groups/${groups[0].id}`);
  assert.ok(review.messages.some((message: any) => message.notice && message.text === '金渐层不在这个群里，没有回答。'));

  // Each chat has a demo line that can be played; an unknown name is refused.
  const play = (name: string) => fetch(base + '/__preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ play: name }) });
  assert.equal((await play('没有这个聊天')).status, 404);
  assert.equal((await play('读书会')).status, 200);
  for (let waited = 0; waited < 8000; waited += 200) {
    const read = await get(`/xbot-api/groups/${groups[1].id}`);
    if (read.messages.at(-1)?.text.startsWith('下次是周六晚上 8 点')) return;
    await new Promise(done => setTimeout(done, 200));
  }
  assert.fail('the played line was not answered');
});
