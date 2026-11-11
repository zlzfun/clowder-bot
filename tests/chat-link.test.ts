import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// A link that opens a chat: /#chat=<name> (chat-list-rules.js linkName, linked,
// linkMissing; app.js openLinked, boot and the hashchange listener). The rules
// run in a bare VM; app.js's own functions are taken out of it and run with the
// shell's state, history and pickers faked, the way the other app.js tests do.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function rules() {
  const window: Any = {};
  vm.runInNewContext(read('client/public/chat-list-rules.js'), { window });
  return window.ClowderListRules;
}
const app = read('client/public/app.js');
const take = (name: string) => {
  const m = new RegExp(`\\n {2}(?:async )?function ${name}\\(.*\\) \\{\\n[\\s\\S]*?\\n {2}\\}\\n`).exec(app);
  assert.ok(m, name + ' is where the shell keeps it');
  return m![0];
};

const bots = [{ name: '布偶猫', primary: true }, { name: '小鲸鱼' }, { name: '读书会' }];
const groups = [{ id: 'g-review', name: '产品评审' }, { id: 'g-books', name: '读书会' }, { id: 'g-twin', name: '产品评审' }, { id: 'g-unnamed', name: '' }];

// ---------------------------------------------------------------- rules
test('a link names a chat only as #chat=<URL-encoded name>; the name is decoded and trimmed, nothing else is read as a link', () => {
  const R = rules();
  assert.equal(R.linkName('#chat=' + encodeURIComponent('布偶猫')), '布偶猫');
  assert.equal(R.linkName('#chat=布偶猫'), '布偶猫', 'an address bar may keep the characters as they are');
  assert.equal(R.linkName('#chat=%20%E5%B0%8F%E9%B2%B8%E9%B1%BC%20'), '小鲸鱼');
  assert.equal(R.linkName('#chat=' + encodeURIComponent('团 子')), '团 子', 'a space inside a name stays');
  assert.equal(R.linkName('#chat=C%2B%2B'), 'C++');
  assert.equal(R.linkName('#chat=a+b'), 'a+b', 'a plus is a plus (encodeURIComponent never writes one for a space)');
  assert.equal(R.linkName('#chat=%E5%B8'), '%E5%B8', 'a malformed escape is read as written, never thrown');
  assert.equal(R.linkName('#chat='), '', 'a link that names nothing');
  for (const other of ['', '#', '#login-code', '#chats=布偶猫', '#x&chat=布偶猫', 'chat=布偶猫', null, undefined]) assert.equal(R.linkName(other as Any), null, String(other));
});

test('the cat with that name opens, else the first group chat with it; nothing answers to an unknown name, and the app says so in one quiet line', () => {
  const R = rules();
  assert.deepEqual(plain(R.linked('小鲸鱼', bots, groups)), { type: 'bot', id: '小鲸鱼' });
  assert.deepEqual(plain(R.linked('读书会', bots, groups)), { type: 'bot', id: '读书会' }, 'a cat before a group of the same name');
  assert.deepEqual(plain(R.linked('产品评审', bots, groups)), { type: 'group', id: 'g-review' }, 'the first group of that name');
  assert.deepEqual(plain(R.linked(' 产品评审 ', bots, groups)), { type: 'group', id: 'g-review' });
  assert.deepEqual(plain(R.linked('g-unnamed', bots, groups)), { type: 'group', id: 'g-unnamed' }, 'a group without a name goes by the name it is shown under');
  assert.equal(R.linked('布偶', bots, groups), null, 'names match whole, never in part');
  assert.equal(R.linked('布偶猫猫', bots, groups), null);
  assert.equal(R.linked('', bots, groups), null);
  assert.equal(R.linked('布偶猫', null, null), null);
  assert.equal(R.linkMissing('没有这只猫'), '列表里没有叫「没有这只猫」的猫猫或群聊。');
  assert.equal(R.linkMissing('长'.repeat(60)).length, '列表里没有叫「」的猫猫或群聊。'.length + 40, 'a long name is clipped');
  assert.equal(R.linkMissing('一\n二'), '列表里没有叫「一 二」的猫猫或群聊。');
});

// ---------------------------------------------------------------- app.js
function shell(hash: string, more: { sel?: Any; peer?: Any; search?: string } = {}) {
  const calls: string[] = [];
  const location = { hash, pathname: '/', search: more.search ?? '' };
  const history = { state: { kept: true }, replaceState(state: Any, _title: string, url: string) { calls.push('replace:' + url + (state && state.kept ? ':kept' : '')); location.hash = ''; } };
  const state: Any = { bots, groups, sel: more.sel ?? null, peer: more.peer ?? null };
  const ctx: Any = {
    location, history, state, calls, console,
    listRules: rules(), Promise, sessionStorage: { getItem: () => '小鲸鱼' },
    quietNote: (text: string) => calls.push('note:' + text),
    closeDrawer: () => calls.push('closeDrawer'),
    selectBot: async (name: string) => { calls.push('selectBot:' + name); state.sel = { type: 'bot', id: name }; },
    selectGroup: async (id: string) => { calls.push('selectGroup:' + id); state.sel = { type: 'group', id }; },
    refreshLists: async () => {}, refreshStatus: async () => {}, refreshNotes: async () => {}, refreshUpdate: async () => {},
    renderMe: () => {}, showNoChat: () => calls.push('showNoChat'), syncPanelDefault: () => {},
    linkReady: false,
  };
  vm.createContext(ctx);
  vm.runInContext(['pickBot', 'pickGroup', 'openLinked', 'boot'].map(take).join(''), ctx);
  return ctx;
}

test('opening a link: the address loses its fragment first, then the chat opens the way a row of the list opens it', async () => {
  const s = shell('#chat=' + encodeURIComponent('小鲸鱼'), { search: '?s=account' });
  await s.openLinked();
  assert.deepEqual(s.calls, ['replace:/?s=account:kept', 'selectBot:小鲸鱼'], 'the query (?s=account) and the history state stay; a reload is not sent back to the chat');
  const g = shell('#chat=' + encodeURIComponent('产品评审'));
  await g.openLinked();
  assert.deepEqual(g.calls, ['replace:/:kept', 'selectGroup:g-review']);
  // A chat already open stays as it is (pickBot / pickGroup only close the list on a narrow window): its live reply, its sends, its draft.
  const open = shell('#chat=' + encodeURIComponent('产品评审'), { sel: { type: 'group', id: 'g-review' } });
  await open.openLinked();
  assert.deepEqual(open.calls, ['replace:/:kept', 'closeDrawer']);
  const cat = shell('#chat=' + encodeURIComponent('小鲸鱼'), { sel: { type: 'bot', id: '小鲸鱼' } });
  await cat.openLinked();
  assert.deepEqual(cat.calls, ['replace:/:kept', 'closeDrawer']);
  // Seen from another person's shared chat, the cat's own chat opens.
  const peer = shell('#chat=' + encodeURIComponent('小鲸鱼'), { sel: { type: 'bot', id: '小鲸鱼' }, peer: { id: 'x' } });
  await peer.openLinked();
  assert.deepEqual(peer.calls, ['replace:/:kept', 'selectBot:小鲸鱼']);
});

test('an unknown name opens nothing and says one quiet line; #login-code and other fragments are not touched; an empty name only tidies the address', async () => {
  const s = shell('#chat=' + encodeURIComponent('没有这只猫'));
  assert.equal(s.openLinked(), null);
  assert.deepEqual(s.calls, ['replace:/:kept', 'note:列表里没有叫「没有这只猫」的猫猫或群聊。']);
  for (const hash of ['#login-code', '', '#top']) {
    const o = shell(hash);
    assert.equal(o.openLinked(), null);
    assert.deepEqual(o.calls, [], hash || '(none)');
    assert.equal(o.location.hash, hash);
  }
  const empty = shell('#chat=');
  assert.equal(empty.openLinked(), null);
  assert.deepEqual(empty.calls, ['replace:/:kept']);
});

test('on first load a link opens its chat instead of the remembered one; an unknown name falls back to it after the quiet line; later links wait for boot', async () => {
  const linked = shell('#chat=' + encodeURIComponent('产品评审'));
  await linked.boot();
  assert.deepEqual(linked.calls, ['replace:/:kept', 'selectGroup:g-review'], 'not the remembered 小鲸鱼');
  assert.equal(linked.linkReady, true);
  const unknown = shell('#chat=' + encodeURIComponent('没有这只猫'));
  await unknown.boot();
  assert.deepEqual(unknown.calls, ['replace:/:kept', 'note:列表里没有叫「没有这只猫」的猫猫或群聊。', 'selectBot:小鲸鱼'], 'the app carries on as usual');
  const plain = shell('');
  await plain.boot();
  assert.deepEqual(plain.calls, ['selectBot:小鲸鱼']);
  // The listener: only once boot has read the first link, and only while the app is shown (signed out, the fragment waits).
  const listener = /\n {2}let linkReady = false;\n {2}window\.addEventListener\("hashchange", \(\) => \{ if \(linkReady && !shell\.hidden\) openLinked\(\); \}\);\n/.exec(app);
  assert.ok(listener, 'app.js listens for a changed address after boot');
  const heard: Array<() => void> = [];
  const ctx: Any = { window: { addEventListener: (type: string, fn: () => void) => { assert.equal(type, 'hashchange'); heard.push(fn); } }, shell: { hidden: false }, opened: 0 };
  vm.runInNewContext(listener![0].replace('let linkReady', 'var linkReady') + 'function openLinked() { opened++; }', ctx);
  heard[0]!(); assert.equal(ctx.opened, 0, 'before boot');
  ctx.linkReady = true; heard[0]!(); assert.equal(ctx.opened, 1);
  ctx.shell.hidden = true; heard[0]!(); assert.equal(ctx.opened, 1, 'while signed out');
});

test('the link opens chats only through pickBot / pickGroup (drafts, open chats and the peer view keep their rules) and reads the rules\' own wording', () => {
  const body = take('openLinked');
  assert.match(body, /pickGroup\(target\.id\) : pickBot\(target\.id\)/);
  assert.doesNotMatch(body, /select(Bot|Group)\(/);
  assert.match(body, /quietNote\(listRules\.linkMissing\(name\)\)/);
  assert.match(body, /history\.replaceState\(history\.state, "", location\.pathname \+ location\.search\)/);
  // #login-code is still read once, at load, by its own line.
  assert.match(app, /const legacyLogin = location\.hash === "#login-code";/);
});
