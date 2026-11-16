import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Doc, El } from './fake-dom.js';

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
  assert.equal(R.linkMissing('没有这只猫'), '没有找到链接里的「没有这只猫」：列表里没有叫这个名字的猫猫或群聊。', 'it names the chat that was not found, so the chat that opens instead is never taken for it');
  assert.equal(R.linkMissing('长'.repeat(60)).length, R.linkMissing('').length + 40, 'a long name is clipped');
  assert.equal(R.linkMissing('一\n二'), '没有找到链接里的「一 二」：列表里没有叫这个名字的猫猫或群聊。');
  assert.equal(R.linkHeld('小鲸鱼'), '有个窗口还开着，链接里的「小鲸鱼」没有打开。关掉它以后再打开这个链接。');
});

// ---------------------------------------------------------------- app.js
// app.js's own pickBot, pickGroup, openLinked, linkHeld, uncover and boot, run
// with the shell's state, history, pickers and covering views faked; the open
// dialogs are elements of a small DOM (tests/fake-dom.ts).
function shell(hash: string, more: { sel?: Any; peer?: Any; search?: string; covered?: (doc: Doc) => void; slow?: boolean; beside?: boolean } = {}) {
  const calls: string[] = [];
  const doc = new Doc();
  const setpage = doc.createElement('div'); setpage.id = 'setpage'; setpage.setAttribute('aria-modal', 'true'); setpage.hidden = true;
  const lightbox = doc.createElement('dialog'); lightbox.id = 'lightbox';
  doc.body.append(setpage, lightbox);
  more.covered?.(doc);
  const location = { hash, pathname: '/', search: more.search ?? '' };
  const history = { state: { kept: true }, replaceState(state: Any, _title: string, url: string) { calls.push('replace:' + url + (state && state.kept ? ':kept' : '')); location.hash = ''; } };
  const state: Any = { bots, groups, sel: more.sel ?? null, peer: more.peer ?? null };
  const panel = doc.createElement('aside'); panel.id = 'panel';
  let release: () => void = () => {};
  const palette = { open: false, isOpen() { return this.open; }, close(opts: Any) { calls.push('palette.close:' + JSON.stringify(opts)); this.open = false; } };
  const ctx: Any = {
    location, history, state, calls, console, document: doc, panel, lightbox, setpage,
    window: { ClowderPalette: palette }, palette,
    // Where the panel sits (chat-panel.js, item 50): beside the chat, or the drawer over it.
    panelPlace: { beside: () => !!more.beside },
    $: (id: string) => doc.getElementById(id),
    listRules: rules(), Promise, sessionStorage: { getItem: () => '小鲸鱼' },
    quietNote: (text: string) => calls.push('note:' + text),
    closeDrawer: () => calls.push('closeDrawer'),
    closePops: () => calls.push('closePops'),
    closeSettings: (restore: boolean) => { calls.push('closeSettings:' + restore); setpage.hidden = true; },
    closeShots: () => { if (lightbox.attrs.has('open')) { calls.push('closeShots'); lightbox.removeAttribute('open'); } },
    panelOpen: (open: boolean) => { calls.push('panelOpen:' + open); panel.classList.toggle('open', open); },
    // The transcript of the first chat can be slow to load (more.slow): boot waits on it.
    selectBot: (name: string) => { calls.push('selectBot:' + name); state.sel = { type: 'bot', id: name }; return more.slow && name === '小鲸鱼' ? new Promise<void>((done) => { release = done; }) : Promise.resolve(); },
    selectGroup: async (id: string) => { calls.push('selectGroup:' + id); state.sel = { type: 'group', id }; },
    refreshLists: async () => {}, refreshStatus: async () => {}, refreshNotes: async () => {}, refreshUpdate: async () => {},
    renderMe: () => {}, showNoChat: () => calls.push('showNoChat'), syncPanelDefault: () => calls.push('syncPanelDefault'),
    linkReady: false,
  };
  vm.createContext(ctx);
  vm.runInContext(['pickBot', 'pickGroup', 'openLinked', 'linkHeld', 'uncover', 'boot'].map(take).join(''), ctx);
  ctx.release = () => release();
  return ctx;
}
const covers = (s: Any) => s.calls.filter((c: string) => /^(closePops|closeSettings|palette|closeShots|panelOpen)/.test(c));

test('opening a link: the address loses its fragment first, then the chat opens the way a row of the list opens it', async () => {
  const s = shell('#chat=' + encodeURIComponent('小鲸鱼'), { search: '?s=account' });
  await s.openLinked();
  assert.deepEqual(s.calls, ['replace:/?s=account:kept', 'closePops', 'selectBot:小鲸鱼'], 'the query (?s=account) and the history state stay; a reload is not sent back to the chat');
  const g = shell('#chat=' + encodeURIComponent('产品评审'));
  await g.openLinked();
  assert.deepEqual(g.calls, ['replace:/:kept', 'closePops', 'selectGroup:g-review']);
  // A chat already open stays as it is (pickBot / pickGroup only close the list on a narrow window): its live reply, its sends, its draft.
  const open = shell('#chat=' + encodeURIComponent('产品评审'), { sel: { type: 'group', id: 'g-review' } });
  await open.openLinked();
  assert.deepEqual(open.calls, ['replace:/:kept', 'closePops', 'closeDrawer']);
  const cat = shell('#chat=' + encodeURIComponent('小鲸鱼'), { sel: { type: 'bot', id: '小鲸鱼' } });
  await cat.openLinked();
  assert.deepEqual(cat.calls, ['replace:/:kept', 'closePops', 'closeDrawer']);
  // Seen from another person's shared chat, the cat's own chat opens.
  const peer = shell('#chat=' + encodeURIComponent('小鲸鱼'), { sel: { type: 'bot', id: '小鲸鱼' }, peer: { id: 'x' } });
  await peer.openLinked();
  assert.deepEqual(peer.calls, ['replace:/:kept', 'closePops', 'selectBot:小鲸鱼']);
});

test('what only shows something is put away before the chat opens: settings, the search palette, the picture viewer, menus, the drawer over the conversation', async () => {
  const s = shell('#chat=' + encodeURIComponent('小鲸鱼'));
  s.setpage.hidden = false;
  s.palette.open = true;
  s.lightbox.setAttribute('open', '');
  s.panel.classList.add('open');
  await s.openLinked();
  assert.deepEqual(covers(s), ['closePops', 'closeSettings:false', 'palette.close:{"restore":false}', 'closeShots', 'panelOpen:false'], 'the drawer closes without changing whether it opens next time (no rememberPanel)');
  assert.equal(s.calls.at(-1), 'selectBot:小鲸鱼', 'then the chat opens, in view');
  assert.equal(s.setpage.hidden, true);
  assert.equal(s.panel.classList.contains('open'), false);
  // Item 50: a panel beside the chat covers nothing, so it stays open and follows the chat that opens.
  const beside = shell('#chat=' + encodeURIComponent('小鲸鱼'), { beside: true });
  beside.panel.classList.add('open');
  await beside.openLinked();
  assert.deepEqual(covers(beside), ['closePops'], 'nothing to put away: the panel beside the chat is not closed');
  assert.equal(beside.panel.classList.contains('open'), true);
  assert.equal(beside.calls.at(-1), 'selectBot:小鲸鱼');
  // Settings and the palette are dialogs too, but only views: they never hold a link back.
  const settingsOnly = shell('#chat=' + encodeURIComponent('产品评审'));
  settingsOnly.setpage.hidden = false;
  await settingsOnly.openLinked();
  assert.equal(settingsOnly.calls.at(-1), 'selectGroup:g-review');
});

test('a dialog holding the owner\'s input or a pending decision is never thrown away for a link: the link opens nothing and says so, and works once the dialog is closed', async () => {
  const kinds: Array<[string, (doc: Doc) => El]> = [
    ['新建猫猫 with a name typed (quick-create)', (doc) => { const root = doc.createElement('div'); root.className = 'modal qc-modal'; const card = doc.createElement('form'); card.className = 'modal-card qc-card'; card.setAttribute('aria-modal', 'true'); root.append(card); doc.body.append(root); return root; }],
    ['a confirmation in the shell\'s #modal', (doc) => { const root = doc.createElement('div'); root.id = 'modal'; root.className = 'modal'; const form = doc.createElement('form'); form.setAttribute('aria-modal', 'true'); root.append(form); doc.body.append(root); return root; }],
    ['a native <dialog> (更换 Agent)', (doc) => { const d = doc.createElement('dialog'); d.setAttribute('open', ''); doc.body.append(d); return d; }],
  ];
  for (const [what, make] of kinds) {
    let dialog: El | null = null;
    const s = shell('#chat=' + encodeURIComponent('小鲸鱼'), { covered: (doc) => { dialog = make(doc); } });
    s.setpage.hidden = false; // also under settings: nothing is put away while the dialog holds the link back
    assert.equal(s.openLinked(), null, what);
    assert.deepEqual(s.calls, ['replace:/:kept', 'note:有个窗口还开着，链接里的「小鲸鱼」没有打开。关掉它以后再打开这个链接。'], what + ': nothing closed, nothing opened; the fragment is gone, so the same link works again');
    assert.equal(s.setpage.hidden, false);
    // The dialog closed (removed, or hidden as #modal is): the same link opens the chat.
    if (dialog!.id === 'modal') { dialog!.hidden = true; dialog!.querySelector('form')!.removeAttribute('aria-modal'); } else dialog!.remove();
    s.location.hash = '#chat=' + encodeURIComponent('小鲸鱼');
    await s.openLinked();
    assert.equal(s.calls.at(-1), 'selectBot:小鲸鱼', what + ': opened once the dialog is closed');
  }
  // A dialog that is in the page but closed does not count.
  const closed = shell('#chat=' + encodeURIComponent('小鲸鱼'), { covered: (doc) => { const d = doc.createElement('div'); d.className = 'modal'; d.hidden = true; d.setAttribute('hidden', ''); const c = doc.createElement('form'); c.setAttribute('aria-modal', 'true'); d.append(c); doc.body.append(d); } });
  await closed.openLinked();
  assert.equal(closed.calls.at(-1), 'selectBot:小鲸鱼');
});

test('an unknown name opens nothing and says one quiet line naming the chat that was not found; #login-code and other fragments are not touched; an empty name only tidies the address', async () => {
  const s = shell('#chat=' + encodeURIComponent('没有这只猫'));
  assert.equal(s.openLinked(), null);
  assert.deepEqual(s.calls, ['replace:/:kept', 'note:没有找到链接里的「没有这只猫」：列表里没有叫这个名字的猫猫或群聊。']);
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

test('on first load a link opens its chat instead of the remembered one; intended: an unknown name is said not found, then the app opens the remembered chat as usual', async () => {
  const linked = shell('#chat=' + encodeURIComponent('产品评审'));
  await linked.boot();
  assert.deepEqual(linked.calls, ['replace:/:kept', 'closePops', 'selectGroup:g-review'], 'not the remembered 小鲸鱼, and the drawer does not open over it by itself');
  assert.equal(linked.linkReady, true);
  const unknown = shell('#chat=' + encodeURIComponent('没有这只猫'));
  await unknown.boot();
  assert.deepEqual(unknown.calls, ['replace:/:kept', 'note:没有找到链接里的「没有这只猫」：列表里没有叫这个名字的猫猫或群聊。', 'selectBot:小鲸鱼', 'syncPanelDefault'],
    'the line says which chat was not found; the remembered chat that opens after it is the usual one, never presented as the linked one');
  const plain = shell('');
  await plain.boot();
  assert.deepEqual(plain.calls, ['selectBot:小鲸鱼', 'syncPanelDefault']);
});

test('a link that arrives while boot is still opening the first chat is not lost: it opens once that chat has opened, and the address is tidied', async () => {
  const s = shell('', { slow: true });
  const booting = s.boot();
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(s.calls, ['selectBot:小鲸鱼'], 'the remembered chat is loading');
  // The address changes now; the listener does nothing before boot is done (linkReady is false) …
  s.location.hash = '#chat=' + encodeURIComponent('产品评审');
  assert.equal(s.linkReady, false);
  s.release();
  await booting;
  // … and boot opens it when the first chat is in.
  assert.deepEqual(s.calls, ['selectBot:小鲸鱼', 'replace:/:kept', 'closePops', 'selectGroup:g-review']);
  assert.equal(s.location.hash, '');
  assert.deepEqual(s.state.sel, { type: 'group', id: 'g-review' });
});

test('the listener: only once boot has read the first link, and only while the app is shown (signed out, the fragment waits)', () => {
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
  assert.match(body, /quietNote\(listRules\.linkHeld\(name\)\)/);
  assert.match(body, /history\.replaceState\(history\.state, "", location\.pathname \+ location\.search\)/);
  assert.doesNotMatch(take('uncover'), /rememberPanel/, 'the drawer is closed for the link, not as the owner\'s choice');
  // #login-code is still read once, at load, by its own line.
  assert.match(app, /const legacyLogin = location\.hash === "#login-code";/);
});
