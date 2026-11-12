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

  // It says what it is without being asked to do anything: a tool that clicks through the staged chats checks this first.
  const identity = await get('/__preview');
  assert.deepEqual([identity.preview, identity.scene, identity.staged, identity.zone], [true, 'showcase', true, zone]);
  assert.deepEqual(identity.plays.sort(), [...catTemplates.map(template => template[5]), '产品评审', '读书会'].sort());

  // The cats are the engine's templates: the name the template gives its cat, its face, its colour — and its own tool.
  const { bots } = await get('/xbot-api/bots');
  assert.deepEqual(bots.map((bot: any) => [bot.templateId, bot.name]), catTemplates.map(template => [template[0], template[5]]));
  const state = await get('/api/state'), client = (name: string) => state.cats.find((cat: any) => cat.name === name).clientId;
  assert.deepEqual(['宪宪', '砚砚', '烁烁', '墨墨', '鲸鲸', '小狸花', '斑斑', '金哥'].map(client), ['anthropic', 'openai', 'google', 'kimi', 'acp', 'opencode', 'antigravity', 'opencode']);
  // On the showcase's computer the three tools the app can connect are there; a new cat can be made from those three faces, as it is, and from no other.
  const faces = (await get('/xbot-api/start')).faces;
  assert.deepEqual(faces.map((face: any) => [face.nickname, face.tool.label, face.tool.usable]), [['宪宪', 'Claude Code', true], ['砚砚', 'Codex', true], ['烁烁', 'AGY Native', false],
    ['墨墨', 'Kimi', true], ['鲸鲸', 'DSH', false], ['小狸花', 'OpenCode', false], ['斑斑', 'Antigravity', false], ['金哥', 'OpenCode', false]]);
  // A cat the engine made on a tool the app cannot connect is shown as kept as it is, not as one of this computer's tools.
  assert.deepEqual([(await get(`${chat('烁烁')}`)).agent.id, (await get(`${chat('宪宪')}`)).agent.id], [null, 'claude']);
  assert.ok(bots.every((bot: any) => bot.avatar_seed === `cat:${bot.templateId}` && /^#[0-9A-F]{6}$/i.test(bot.accent?.primary)));
  assert.equal(new Set(bots.map((bot: any) => bot.accent.primary)).size, 8);
  assert.deepEqual(bots.filter((bot: any) => bot.pinned).map((bot: any) => bot.name), ['宪宪']);

  const { groups } = await get('/xbot-api/groups');
  assert.deepEqual(groups.map((group: any) => [group.name, group.members.length]), [['产品评审', 3], ['读书会', 4]]);
  const [review, club] = groups.map((group: any) => `/xbot-api/groups/${group.id}`);

  // The contact list: two requests waiting, unread only where the scene left something unread.
  const status = await get('/xbot-api/bots/status'), row = (name: string) => status.bots.find((bot: any) => bot.bot === name);
  assert.deepEqual(status.bots.filter((bot: any) => bot.state === 'awaiting').map((bot: any) => bot.bot), ['鲸鲸', '小狸花']);
  assert.deepEqual(status.bots.map((bot: any) => bot.unread), [0, 0, 0, 0, 2, 0, 0, 0]);
  assert.deepEqual(status.groups.map((group: any) => group.activity.unread), [3, 0]);
  assert.equal(row('鲸鲸').activity.last.text, `想设一个定时：写周报 · 每周五 17:00（${zone}）`);
  assert.deepEqual([row('墨墨').activity.last.text, row('墨墨').activity.last.files], ['', 1]);
  assert.ok(status.bots.every((bot: any) => bot.activity.readStatus === 'ready' && bot.activity.last));
  // Nothing is dated in the future, and every conversation runs forward in time.
  for (const name of catTemplates.map(template => template[5])) {
    const times = (await rows(name)).map((message: any) => Date.parse(message.time));
    assert.ok(times.every((time: number, index: number) => time <= Date.now() && (index === 0 || time >= times[index - 1])), name);
  }

  // Each chat's own ability, as the adapter projects it.
  assert.ok((await rows('宪宪')).some((message: any) => message.ended?.how === 'stopped'));
  assert.deepEqual(kinds(await rows('砚砚')), ['card', 'checklist', 'diff', 'checklist']);
  const siamese = await rows('烁烁');
  assert.deepEqual(siamese.flatMap((message: any) => (message.blocks ?? []).map((block: any) => [block.mode, block.answered])), [['single', true], ['multiple', false]]);
  assert.deepEqual(siamese.flatMap((message: any) => message.attachments.map((file: any) => [file.name, file.mime, file.availability])), [['首页配色稿.png', 'image/png', 'available']]);
  const picture = await fetch(base + `/xbot-api/files/${encodeURIComponent(siamese.flatMap((message: any) => message.attachments)[0].id)}/image`);
  assert.deepEqual([picture.status, picture.headers.get('content-type')], [200, 'image/png']);
  const van = await rows('墨墨');
  assert.deepEqual(van.flatMap((message: any) => message.attachments.map((file: any) => [file.name, file.kind])), [['周会记录.txt', 'attachment'], ['周会纪要.md', 'deliverable'], ['待办清单.md', 'deliverable']]);
  assert.equal((await get(`${chat('墨墨')}/files`)).files.length, 3);
  const whale = await rows('鲸鲸');
  assert.deepEqual(whale.filter((message: any) => message.reminder).map((message: any) => message.content), ['提醒：看一眼当天的日程', '提醒：看一眼当天的日程']);
  // The reminder is for 09:00 in its own time zone, and that is when the staged ones came due.
  assert.deepEqual(whale.filter((message: any) => message.reminder).map((message: any) => new Date(message.time).toLocaleTimeString('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit' })), ['09:00', '09:00']);
  assert.deepEqual(whale.flatMap((message: any) => (message.blocks ?? []).map((block: any) => block.approval?.state ?? 'open')), ['approved', 'open']);
  const waiting = (await get(`${chat('鲸鲸')}/approvals`)).approvals;
  assert.deepEqual(waiting.map((item: any) => [item.kind, item.body, item.approve?.label]), [['schedule', `写周报 · 每周五 17:00（${zone}）`, '设上']]);
  assert.deepEqual((await get(`${chat('鲸鲸')}/routines`)).routines.map((routine: any) => [routine.name, routine.status, routine.runStats.delivered]), [['看当天的日程', 'scheduled', 2]]);
  assert.deepEqual((await get(`${chat('小狸花')}/approvals`)).approvals.map((item: any) => [item.kind, item.body]), [['preference', '引用资料时带上出处']]);
  // What is remembered is listed the way the engine lists it, and leads back to what the owner said.
  const taste = (await get('/xbot-api/memory/taste')).entries, li = await rows('小狸花');
  assert.deepEqual(taste.map((entry: any) => [entry.title, /^taste-[0-9a-f]{24}$/.test(entry.id), /^\d{4}-\d{2}-\d{2}$/.test(entry.updatedAt)]), [['回答时先说结论，再给依据', true, true]]);
  const source = await get(`/xbot-api/memory/taste/${taste[0].id}/source?revision=${encodeURIComponent(taste[0].revision)}`);
  assert.deepEqual(source.sources.map((item: any) => [item.label, item.canOpen, item.messageId]), [['小狸花', true, li.find((message: any) => message.content === '以后回答我，先说结论，再给依据。').id]]);
  assert.deepEqual((await get('/xbot-api/memory/profile')).entries.map((entry: any) => [entry.id, entry.title]), [['capsule', '开场简介']]);
  const bengal = await rows('斑斑');
  assert.deepEqual(bengal.filter((message: any) => message.ended).map((message: any) => [message.ended.how, message.ended.reason]), [['failed', 'timeout'], ['interrupted', 'process_restart']]);
  assert.equal(bengal.at(-1).blocks_hidden, 1);
  // 金哥 is read ten messages at a time and keeps an earlier conversation; that page size is its own.
  const gold = await get(`${chat('金哥')}/transcript`);
  assert.equal(gold.hasMore, true);
  // The owner's last question quotes an answer from an earlier page; the quote is drawn once that page has been read.
  await get(`${chat('金哥')}/transcript?before=${encodeURIComponent(gold.before)}`);
  assert.ok((await rows('金哥')).some((message: any) => message.role === 'user' && message.reply_to > 0));
  assert.equal((await get(`${chat('金哥')}/conversations`)).conversations.length, 2);
  const [paged, whole] = await Promise.all([get(`${chat('金哥')}/transcript`), get(review)]);
  assert.deepEqual([paged.hasMore, whole.hasMore, whole.messages.length], [true, false, 10]);
  assert.ok(whole.messages.some((message: any) => message.notice && message.text === '金哥不在这个群里，没有回答。'));
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

  assert.equal(await play('宪宪'), 200);
  assert.ok((await last('宪宪', message => message.content.includes('## 提醒文案'))).content.endsWith(said));
  assert.equal(await play('砚砚'), 200);
  assert.deepEqual(kinds([await last('砚砚', message => !!message.blocks)]), ['card', 'checklist']);
  assert.equal(await play('烁烁'), 200);
  assert.deepEqual((await last('烁烁', message => !!message.blocks)).blocks.map((block: any) => [block.mode, block.answered, block.template]), [['single', false, '我选{selection}']]);
  assert.equal(await play('墨墨'), 200);
  assert.deepEqual((await last('墨墨', message => message.attachments.length > 0)).attachments.map((file: any) => file.name), ['一页纸.md']);
  assert.equal(await play('金哥'), 200);
  assert.ok((await last('金哥', message => message.content.startsWith('稳着呢'))).content.endsWith(said));

  // A reminder asked for in words waits for a yes; the yes makes it one of the cat's reminders.
  assert.equal(await play('鲸鲸'), 200);
  const asked = await until('鲸鲸', async () => (await get(`${chat('鲸鲸')}/approvals`)).approvals, list => list.length === 2);
  const thread = (await get(`${chat('鲸鲸')}/transcript`)).thread_id;
  assert.equal((await post(`${chat('鲸鲸')}/approvals/${asked[0].id}`, { decision: 'approve', expectedThreadId: thread })).status, 200);
  assert.deepEqual((await get(`${chat('鲸鲸')}/routines`)).routines.map((routine: any) => routine.name).sort(), ['写周报', '看当天的日程']);

  // A preference asked for in words waits for a yes; the yes keeps it, with the owner's sentence as its source.
  assert.equal(await play('小狸花'), 200);
  const wanted = await until('小狸花', async () => (await get(`${chat('小狸花')}/approvals`)).approvals, list => list.length === 2);
  const newest = wanted.find((item: any) => item.body === '以后给我的建议不要超过三条。');
  assert.equal((await post(`${chat('小狸花')}/approvals/${newest.id}`, { decision: 'approve', expectedThreadId: (await get(`${chat('小狸花')}/transcript`)).thread_id })).status, 200);
  const kept = (await get('/xbot-api/memory/taste')).entries.find((entry: any) => entry.title === '以后给我的建议不要超过三条。');
  const origin = await get(`/xbot-api/memory/taste/${kept.id}/source?revision=${encodeURIComponent(kept.revision)}`);
  assert.equal(origin.sources[0].messageId, (await rows('小狸花')).find((message: any) => message.role === 'user' && message.content === '以后给我的建议不要超过三条。').id);

  // 斑斑 fails the first time and says so; the same line again goes through, and that reply says it is canned.
  assert.equal(await play('斑斑'), 200);
  assert.deepEqual((await until('斑斑', async () => (await rows('斑斑')).at(-1), message => message.status === 'failed')).ended, { how: 'failed', reason: 'timeout' });
  assert.equal(await play('斑斑'), 200);
  const second = await last('斑斑', message => !!message.blocks);
  assert.ok(second.content.endsWith(said) && second.blocks[0].title === '启动图 · 第 2 稿');

  // In a group every cat that was asked answers, and the group's first canned reply says it is canned.
  assert.equal(await play('产品评审'), 200);
  const answers = (await until('产品评审', async () => (await get(review)).messages.slice(-3), tail => tail.every((message: any) => message.kind === 'bot' && message.status === 'completed' && Date.parse(message.time) > Date.now() - 20_000)));
  assert.deepEqual(answers.map((message: any) => message.sender).sort(), ['宪宪', '烁烁', '砚砚'].sort());
  assert.equal(answers.filter((message: any) => message.text.endsWith(said)).length, 1);
  // Said while a cat is writing: the same reply takes it in, as on the engine, and names the message it now follows.
  assert.equal((await post('/__preview', { speed: 0.3 })).status, 200);
  const before = (await rows('砚砚')).length, tell = (text: string) => post(`${chat('砚砚')}/messages`, { text });
  assert.equal((await tell('那导出呢？')).status, 200);
  // (the second one is said once the reply has begun, as a person would)
  await until('砚砚 has begun', async () => (await rows('砚砚')).at(-1), row => row.role === 'assistant' && row.in_progress === true);
  assert.equal((await tell('再看一眼同步。')).status, 200);
  const both = await until('砚砚 answers both in one reply', async () => (await rows('砚砚')).slice(before), tail => tail.length === 3 && tail[1].status === 'completed');
  assert.deepEqual(both.map((row: any) => row.role), ['user', 'assistant', 'user']);
  assert.equal(both[1].follows, both[2].seq);
  assert.deepEqual(kinds([both[1]]), ['card', 'checklist', 'card', 'checklist'], 'one reply carries both answers');
  assert.equal(both[1].content.split('看了导出那段').length - 1, 2); assert.doesNotMatch(both[1].content, /🐾/, 'no signature between them');
  assert.equal((await post('/__preview', { speed: 0.02 })).status, 200);

  // A message that names no cat is taken the way the engine decides it: by the cat the owner last addressed by name.
  const say = (text: string) => post(`${review}/messages`, { text });
  assert.equal((await say('@砚砚 导出那段看过了吗？')).status, 202);
  await until('砚砚 answers', async () => (await get(review)).messages.at(-1), message => message.kind === 'bot' && message.sender === '砚砚' && message.status === 'completed');
  assert.equal((await say('那今天能合吗？')).status, 202);
  await until('砚砚 takes the next one too', async () => (await get(review)).messages.slice(-2), tail => tail[0]?.text === '那今天能合吗？' && tail[1]?.kind === 'bot' && tail[1].sender === '砚砚' && tail[1].status === 'completed');
  assert.equal(await play('读书会'), 200);
  const next = await until('读书会', async () => (await get(club)).messages.at(-1), message => message.kind === 'bot' && message.status === 'completed' && message.text.startsWith('下次是周六晚上 8 点'));
  assert.ok(next.text.endsWith(said));
});
