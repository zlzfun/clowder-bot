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
import { cpSync, existsSync, lstatSync, readFileSync, renameSync, symlinkSync } from 'node:fs';
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

console.log(`数据：${source}\n移到：${target}${backup ? `\n先备份到：${backup}` : ''}\n原位置留一个链接，之前保存的路径继续可用。`);
if (!apply) { console.log('这是预览，什么都没有改动。加 --apply 才会执行。'); process.exit(0); }
if (backup) { cpSync(source, backup, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true }); console.log('已备份。'); }
try { renameSync(source, target); }
catch (error) {
  if (error.code === 'EXDEV') stop('目标在另一个磁盘卷上，不能直接移动。请选同一卷上的位置，或手动复制后核对再建立链接。');
  throw error;
}
symlinkSync(target, source, 'dir');
console.log(`已移动。没有显式设置数据目录的启动方式会自动使用 ${target}；\n用 BOT_RUNTIME_DATA_DIR / BOT_PRODUCT_DATA_FILE 指定过路径的服务，请改为 ${join(target, 'native')} 与 ${join(target, 'bot', 'presentation.json')}。`);
