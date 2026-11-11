import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { catTemplates } from './native-fixture.js';

// `npm run showcase` (scripts/showcase-scene.ts) is read by the real adapter: when a projection changes,
// a staged chat can quietly stop showing what it is there to show. This starts it, looks at each chat as
// it is staged, and then plays each chat's demo line to its end.
const root = resolve(import.meta.dirname, '..');
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const freePort = () => new Promise<number>((done, fail) => {
  const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); });
});

test('the showcase stages one cat per template, and each chat shows what it is there for', async t => {
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  // Its stdin is a pipe from this process: the showcase leaves when the pipe closes, so it cannot outlive a test run that was killed.
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/preview-fixture.ts'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PREVIEW_PORT: String(port), PREVIEW_SCENE: 'showcase', PREVIEW_PARENT: 'stdin' } });
  const gone = new Promise<void>(done => child.once('exit', () => done()));
  t.after(async () => {
    child.stdin.end(); child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 3000);
    await gone; clearTimeout(force);
  });
  let output = '';
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('the showcase did not start:\n' + output)), 30_000);
    const read = (chunk: Buffer) => { output += chunk; if (/showcase \(staged chats/.test(output)) { clearTimeout(timer); done(); } };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.once('exit', code => { clearTimeout(timer); fail(new Error(`the showcase exited (${code}):\n${output}`)); });
  });
  const get = async (path: string) => { const response = await fetch(base + path); assert.equal(response.status, 200, path); return response.json() as Promise<any>; };
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const chat = (name: string) => `/xbot-api/bots/${encodeURIComponent(name)}`;
  const rows = async (name: string) => (await get(`${chat(name)}/transcript`)).messages.filter((message: any) => message.role !== 'tool');
  const kinds = (messages: any[]) => messages.flatMap(message => (message.blocks ?? []).map((block: any) => block.kind));
  /** Reads until the answer satisfies `settled`; fails with what was last read. */
  const until = async <T>(what: string, read: () => Promise<T>, settled: (value: T) => boolean): Promise<T> => {
    let value = await read();
    for (let waited = 0; !settled(value); waited += 100) {
      if (waited > 10_000) assert.fail(`${what}: not reached; last read ${JSON.stringify(value)?.slice(0, 600)}`);
      await new Promise(done => setTimeout(done, 100)); value = await read();
    }
    return value;
  };

  // The cats are the engine's templates: its name, its face, its colour.
  const { bots } = await get('/xbot-api/bots');
  assert.deepEqual(bots.map((bot: any) => [bot.templateId, bot.name]), catTemplates.map(([id, name]) => [id, name]));
  assert.ok(bots.every((bot: any) => bot.avatar_seed === `cat:${bot.templateId}` && /^#[0-9A-F]{6}$/i.test(bot.accent?.primary)));
  assert.equal(new Set(bots.map((bot: any) => bot.accent.primary)).size, 8);
  assert.deepEqual(bots.filter((bot: any) => bot.pinned).map((bot: any) => bot.name), ['布偶猫']);

  const { groups } = await get('/xbot-api/groups');
  assert.deepEqual(groups.map((group: any) => [group.name, group.members.length]), [['产品评审', 3], ['读书会', 4]]);
  const [review, club] = groups.map((group: any) => `/xbot-api/groups/${group.id}`);

  // The contact list: two requests waiting, unread only where the scene left something unread.
  const status = await get('/xbot-api/bots/status'), row = (name: string) => status.bots.find((bot: any) => bot.bot === name);
  assert.deepEqual(status.bots.filter((bot: any) => bot.state === 'awaiting').map((bot: any) => bot.bot), ['小鲸鱼', '狸花猫']);
  assert.deepEqual(status.bots.map((bot: any) => bot.unread), [0, 0, 0, 0, 2, 0, 0, 0]);
  assert.deepEqual(status.groups.map((group: any) => group.activity.unread), [3, 0]);
  assert.equal(row('小鲸鱼').activity.last.text, `想设一个定时：写周报 · 每周五 17:00（${zone}）`);
  assert.deepEqual([row('梵花猫').activity.last.text, row('梵花猫').activity.last.files], ['', 1]);
  assert.ok(status.bots.every((bot: any) => bot.activity.readStatus === 'ready' && bot.activity.last));
  // Nothing is dated in the future, and every conversation runs forward in time.
  for (const name of catTemplates.map(([, name]) => name)) {
    const times = (await rows(name)).map((message: any) => Date.parse(message.time));
    assert.ok(times.every((time: number, index: number) => time <= Date.now() && (index === 0 || time >= times[index - 1])), name);
  }

  // Each chat's own ability, as the adapter projects it.
  assert.ok((await rows('布偶猫')).some((message: any) => message.ended?.how === 'stopped'));
  assert.deepEqual(kinds(await rows('缅因猫')), ['card', 'checklist', 'diff', 'checklist']);
  const siamese = await rows('暹罗猫');
  assert.deepEqual(siamese.flatMap((message: any) => (message.blocks ?? []).map((block: any) => [block.mode, block.answered])), [['single', true], ['multiple', false]]);
  assert.deepEqual(siamese.flatMap((message: any) => message.attachments.map((file: any) => [file.name, file.mime, file.availability])), [['首页配色稿.png', 'image/png', 'available']]);
  const picture = await fetch(base + `/xbot-api/files/${encodeURIComponent(siamese.flatMap((message: any) => message.attachments)[0].id)}/image`);
  assert.deepEqual([picture.status, picture.headers.get('content-type')], [200, 'image/png']);
  const van = await rows('梵花猫');
  assert.deepEqual(van.flatMap((message: any) => message.attachments.map((file: any) => [file.name, file.kind])), [['周会记录.txt', 'attachment'], ['周会纪要.md', 'deliverable'], ['待办清单.md', 'deliverable']]);
  assert.equal((await get(`${chat('梵花猫')}/files`)).files.length, 3);
  const whale = await rows('小鲸鱼');
  assert.deepEqual(whale.filter((message: any) => message.reminder).map((message: any) => message.content), ['提醒：看一眼当天的日程', '提醒：看一眼当天的日程']);
  // The reminder is for 09:00 in its own time zone, and that is when the staged ones came due.
  assert.deepEqual(whale.filter((message: any) => message.reminder).map((message: any) => new Date(message.time).toLocaleTimeString('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit' })), ['09:00', '09:00']);
  assert.deepEqual(whale.flatMap((message: any) => (message.blocks ?? []).map((block: any) => block.approval?.state ?? 'open')), ['approved', 'open']);
  const waiting = (await get(`${chat('小鲸鱼')}/approvals`)).approvals;
  assert.deepEqual(waiting.map((item: any) => [item.kind, item.body, item.approve?.label]), [['schedule', `写周报 · 每周五 17:00（${zone}）`, '设上']]);
  assert.deepEqual((await get(`${chat('小鲸鱼')}/routines`)).routines.map((routine: any) => [routine.name, routine.status, routine.runStats.delivered]), [['看当天的日程', 'scheduled', 2]]);
  assert.deepEqual((await get(`${chat('狸花猫')}/approvals`)).approvals.map((item: any) => [item.kind, item.body]), [['preference', '引用资料时带上出处']]);
  // What is remembered is listed the way the engine lists it, and leads back to what the owner said.
  const taste = (await get('/xbot-api/memory/taste')).entries, li = await rows('狸花猫');
  assert.deepEqual(taste.map((entry: any) => [entry.title, /^taste-[0-9a-f]{24}$/.test(entry.id), /^\d{4}-\d{2}-\d{2}$/.test(entry.updatedAt)]), [['回答时先说结论，再给依据', true, true]]);
  const source = await get(`/xbot-api/memory/taste/${taste[0].id}/source?revision=${encodeURIComponent(taste[0].revision)}`);
  assert.deepEqual(source.sources.map((item: any) => [item.label, item.canOpen, item.messageId]), [['狸花猫', true, li.find((message: any) => message.content === '以后回答我，先说结论，再给依据。').id]]);
  assert.deepEqual((await get('/xbot-api/memory/profile')).entries.map((entry: any) => [entry.id, entry.title]), [['capsule', '开场简介']]);
  const bengal = await rows('孟加拉猫');
  assert.deepEqual(bengal.filter((message: any) => message.ended).map((message: any) => [message.ended.how, message.ended.reason]), [['failed', 'timeout'], ['interrupted', 'process_restart']]);
  assert.equal(bengal.at(-1).blocks_hidden, 1);
  // 金渐层 is read ten messages at a time and keeps an earlier conversation; that page size is its own.
  const gold = await get(`${chat('金渐层')}/transcript`);
  assert.equal(gold.hasMore, true);
  // The owner's last question quotes an answer from an earlier page; the quote is drawn once that page has been read.
  await get(`${chat('金渐层')}/transcript?before=${encodeURIComponent(gold.before)}`);
  assert.ok((await rows('金渐层')).some((message: any) => message.role === 'user' && message.reply_to > 0));
  assert.equal((await get(`${chat('金渐层')}/conversations`)).conversations.length, 2);
  const [paged, whole] = await Promise.all([get(`${chat('金渐层')}/transcript`), get(review)]);
  assert.deepEqual([paged.hasMore, whole.hasMore, whole.messages.length], [true, false, 10]);
  assert.ok(whole.messages.some((message: any) => message.notice && message.text === '金渐层不在这个群里，没有回答。'));
  // The vote in 读书会 was answered the way the app words an answer to a titled choice.
  const voted = (await get(club)).messages;
  assert.deepEqual(voted.flatMap((message: any) => (message.blocks ?? []).map((block: any) => [block.kind, block.title, block.answered, block.selected])), [['choices', '这个月读哪一本', true, ['list']]]);
  assert.ok(voted.some((message: any) => message.kind === 'person' && message.text === '我选了：《清单革命》（这个月读哪一本）'));

  // Each chat's demo line, played to its end (fast). An unknown name, or a name that is only a property of an object, is refused.
  const play = async (name: string) => (await post('/__preview', { play: name })).status;
  assert.equal((await post('/__preview', { speed: 0.02 })).status, 200);
  assert.deepEqual([await play('没有这个聊天'), await play('toString')], [404, 404]);
  const said = '（这里是示例环境，回复是预先写好的。）';
  const last = (name: string, settled: (message: any) => boolean) => until(name, async () => (await rows(name)).at(-1), message => message.role === 'assistant' && message.status === 'completed' && settled(message));

  assert.equal(await play('布偶猫'), 200);
  assert.ok((await last('布偶猫', message => message.content.includes('## 提醒文案'))).content.endsWith(said));
  assert.equal(await play('缅因猫'), 200);
  assert.deepEqual(kinds([await last('缅因猫', message => !!message.blocks)]), ['card', 'checklist']);
  assert.equal(await play('暹罗猫'), 200);
  assert.deepEqual((await last('暹罗猫', message => !!message.blocks)).blocks.map((block: any) => [block.mode, block.answered, block.template]), [['single', false, '我选{selection}']]);
  assert.equal(await play('梵花猫'), 200);
  assert.deepEqual((await last('梵花猫', message => message.attachments.length > 0)).attachments.map((file: any) => file.name), ['一页纸.md']);
  assert.equal(await play('金渐层'), 200);
  assert.ok((await last('金渐层', message => message.content.startsWith('稳着呢'))).content.endsWith(said));

  // A reminder asked for in words waits for a yes; the yes makes it one of the cat's reminders.
  assert.equal(await play('小鲸鱼'), 200);
  const asked = await until('小鲸鱼', async () => (await get(`${chat('小鲸鱼')}/approvals`)).approvals, list => list.length === 2);
  const thread = (await get(`${chat('小鲸鱼')}/transcript`)).thread_id;
  assert.equal((await post(`${chat('小鲸鱼')}/approvals/${asked[0].id}`, { decision: 'approve', expectedThreadId: thread })).status, 200);
  assert.deepEqual((await get(`${chat('小鲸鱼')}/routines`)).routines.map((routine: any) => routine.name).sort(), ['写周报', '看当天的日程']);

  // A preference asked for in words waits for a yes; the yes keeps it, with the owner's sentence as its source.
  assert.equal(await play('狸花猫'), 200);
  const wanted = await until('狸花猫', async () => (await get(`${chat('狸花猫')}/approvals`)).approvals, list => list.length === 2);
  const newest = wanted.find((item: any) => item.body === '以后给我的建议不要超过三条。');
  assert.equal((await post(`${chat('狸花猫')}/approvals/${newest.id}`, { decision: 'approve', expectedThreadId: (await get(`${chat('狸花猫')}/transcript`)).thread_id })).status, 200);
  const kept = (await get('/xbot-api/memory/taste')).entries.find((entry: any) => entry.title === '以后给我的建议不要超过三条。');
  const origin = await get(`/xbot-api/memory/taste/${kept.id}/source?revision=${encodeURIComponent(kept.revision)}`);
  assert.equal(origin.sources[0].messageId, (await rows('狸花猫')).find((message: any) => message.role === 'user' && message.content === '以后给我的建议不要超过三条。').id);

  // 孟加拉猫 fails the first time and says so; the same line again goes through, and that reply says it is canned.
  assert.equal(await play('孟加拉猫'), 200);
  assert.deepEqual((await until('孟加拉猫', async () => (await rows('孟加拉猫')).at(-1), message => message.status === 'failed')).ended, { how: 'failed', reason: 'timeout' });
  assert.equal(await play('孟加拉猫'), 200);
  const second = await last('孟加拉猫', message => !!message.blocks);
  assert.ok(second.content.endsWith(said) && second.blocks[0].title === '启动图 · 第 2 稿');

  // In a group every cat that was asked answers, and the group's first canned reply says it is canned.
  assert.equal(await play('产品评审'), 200);
  const answers = (await until('产品评审', async () => (await get(review)).messages.slice(-3), tail => tail.every((message: any) => message.kind === 'bot' && message.status === 'completed' && Date.parse(message.time) > Date.now() - 20_000)));
  assert.deepEqual(answers.map((message: any) => message.sender).sort(), ['布偶猫', '暹罗猫', '缅因猫'].sort());
  assert.equal(answers.filter((message: any) => message.text.endsWith(said)).length, 1);
  assert.equal(await play('读书会'), 200);
  const next = await until('读书会', async () => (await get(club)).messages.at(-1), message => message.kind === 'bot' && message.status === 'completed' && message.text.startsWith('下次是周六晚上 8 点'));
  assert.ok(next.text.endsWith(said));
});
