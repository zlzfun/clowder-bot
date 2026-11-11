// Move an install's runtime data out of this checkout, so cats stop reading
// the repository's CLAUDE.md / AGENTS.md (docs/upstream-maintenance.md「数据位置」).
//
//   npm run data:move                       what would happen (nothing is changed)
//   npm run data:move -- --apply            move ./data to ~/.clowder-bot
//   npm run data:move -- --apply --to /abs/dir --backup /abs/backup-dir
//
// ./data becomes a link to the new place: conversations made before the move
// keep working through the paths they stored (and keep reading the repository's
// instructions until a new conversation is started); new conversations and new
// cats work in the real directory outside the checkout. Stop the runtime and
// the Bot first. Services started with explicit BOT_RUNTIME_DATA_DIR /
// BOT_PRODUCT_DATA_FILE must be pointed at the new place by hand.
import { cpSync, existsSync, lstatSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { enclosingRepository } from '../shared/data-location.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const value = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const apply = args.includes('--apply');
const source = join(root, 'data');
const target = resolve(value('--to') ?? join(homedir(), '.clowder-bot'));
const backup = value('--backup') ? resolve(value('--backup')) : undefined;
const stop = message => { console.error(message); process.exit(1); };

if (!existsSync(source)) stop(`这里没有 ${source}，没有需要移动的数据。`);
if (lstatSync(source).isSymbolicLink()) stop(`${source} 已经是一个链接，数据已经不在检出里了。`);
if (!lstatSync(source).isDirectory()) stop(`${source} 不是目录。`);
if (existsSync(target)) stop(`${target} 已经存在。换一个位置（--to），不会覆盖已有内容。`);
if (backup && existsSync(backup)) stop(`${backup} 已经存在。备份不会覆盖已有内容。`);
if (!existsSync(dirname(target))) stop(`${dirname(target)} 不存在。`);
const repository = enclosingRepository(dirname(target));
if (repository) stop(`${target} 仍在代码仓库 ${repository} 里。请选仓库之外的位置。`);
// A runtime that still owns the data would keep writing to the old inode paths mid-move.
const lock = join(source, 'native', 'runtime.lock');
if (existsSync(lock)) {
  const owner = JSON.parse(readFileSync(lock, 'utf8'));
  let alive = true;
  try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
  if (alive) stop(`原生运行时（PID ${owner.pid}）还在使用这些数据。请先停止它和 Bot，再移动。`);
}
// The Bot keeps no lock of its own; one that answers on its port is still writing its presentation file here.
const port = Number(process.env.PORT || 3210);
const bot = await fetch(`http://127.0.0.1:${port}/xbot-api/session`, { signal: AbortSignal.timeout(2000) }).then(response => response.ok ? response.json() : null).catch(() => null);
if (bot?.engine === 'clowder-ai') stop(`Bot 还在运行（端口 ${port}）。请先停止它，再移动。`);

console.log(`数据：${source}\n移到：${target}${backup ? `\n先备份到：${backup}` : ''}\n原位置留一个链接，之前保存的路径继续可用。`);
if (!apply) { console.log('这是预览，什么都没有改动。加 --apply 才会执行。'); process.exit(0); }
// While the data is being copied and moved, the runtime must not start on it: the launcher refuses a data
// directory whose runtime.lock names a living process, and the lock travels with the directory.
const held = existsSync(join(source, 'native'));
if (held) {
  rmSync(lock, { force: true }); // only a dead owner's lock can still be here
  try { writeFileSync(lock, JSON.stringify({ pid: process.pid, moving: true }), { flag: 'wx', mode: 0o600 }); }
  catch { stop('另一个进程刚刚开始使用这些数据。请确认运行时和 Bot 都已停止，再试一次。'); }
}
const release = () => { for (const file of [lock, join(target, 'native', 'runtime.lock')]) try { if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) rmSync(file); } catch { /* not there, or not ours */ } };
try {
  if (backup) { cpSync(source, backup, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, filter: path => path !== lock }); console.log('已备份。'); }
  try { renameSync(source, target); }
  catch (error) {
    if (error.code === 'EXDEV') { release(); stop('目标在另一个磁盘卷上，不能直接移动。请选同一卷上的位置，或手动复制后核对再建立链接。'); }
    throw error;
  }
  try { symlinkSync(target, source, 'dir'); }
  catch (error) {
    // Something recreated ./data between the move and the link (a Bot that was started meanwhile). The data
    // itself is complete at the new place; what was written here since is set aside, never deleted.
    if (error.code !== 'EEXIST') { console.error(`数据已经完整移到 ${target}，但没能在原位置建立链接：${error.message}\n请手动执行：ln -s "${target}" "${source}"`); process.exitCode = 1; }
    else {
      const aside = `${source}.written-during-move-${Date.now()}`;
      try {
        renameSync(source, aside); symlinkSync(target, source, 'dir');
        console.error(`移动期间有进程又在 ${source} 写入了内容，已原样挪到 ${aside}（没有删除）。数据在 ${target}；请停止那个进程，核对后再启动。`);
      } catch (again) { console.error(`数据已经完整移到 ${target}，但原位置被占用，没能建立链接：${again.message}\n请停止仍在运行的 Bot，把 ${source} 挪开后执行：ln -s "${target}" "${source}"`); }
      process.exitCode = 1;
    }
  }
} finally { if (held) release(); }
if (process.exitCode) process.exit();
console.log(`已移动。没有显式设置数据目录的启动方式会自动使用 ${target}；\n用 BOT_RUNTIME_DATA_DIR / BOT_PRODUCT_DATA_FILE 指定过路径的服务，请改为 ${join(target, 'native')} 与 ${join(target, 'bot', 'presentation.json')}。`);
