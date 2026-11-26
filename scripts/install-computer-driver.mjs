// Install the desktop driver behind 「这台电脑」: cua-driver's own signed app,
// at the release pinned in computer-driver.lock.json (docs/upstream-maintenance.md
// 「电脑驱动」).
//
//   npm run computer:install                      download the pinned release and install it
//   npm run computer:install -- --from /abs/file  use an archive already on disk (same checks)
//   npm run computer:install -- --check           say what is installed (nothing is changed)
//
// The app goes to <data root>/tools/CuaDriver.app, where the Bot looks first.
// Nothing is installed unless all of this holds: the archive's SHA-256 is the
// pinned one, the app's signature verifies, it is signed by the pinned team
// with the pinned bundle id, and Gatekeeper accepts it. macOS grants are not
// touched: the driver asks for them itself the first time a cat is given 电脑.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, resolve } from 'node:path';
import { dataRoot } from '../shared/data-location.mjs';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(join(root, 'computer-driver.lock.json'), 'utf8'));
const args = process.argv.slice(2);
const value = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const stop = message => { console.error(message); process.exit(1); };
const tools = join(dataRoot(root), 'tools'), installed = join(tools, 'CuaDriver.app');
const quiet = (file, argv) => { const done = spawnSync(file, argv, { encoding: 'utf8' }); return { ok: done.status === 0, out: done.stdout ?? '', err: done.stderr ?? '' }; };
// Inside the work below a refusal is thrown, so that what was unpacked is cleared away first.
class Refused extends Error {}
const refuse = message => { throw new Refused(message); };

/** Why this app is not the pinned driver, or undefined when it is. */
function refusal(app) {
  if (!existsSync(join(app, 'Contents', 'MacOS', 'cua-driver'))) return '里面没有驱动程序';
  if (!quiet('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]).ok) return '签名校验没有通过';
  // `codesign -d` writes what it found to stderr.
  const signed = quiet('/usr/bin/codesign', ['-dv', '--verbose=2', app]).err;
  if (!new RegExp(`^Identifier=${lock.bundleId.replaceAll('.', '\\.')}$`, 'm').test(signed)) return `不是 ${lock.bundleId}`;
  if (!new RegExp(`^TeamIdentifier=${lock.teamIdentifier}$`, 'm').test(signed)) return `不是由 ${lock.teamIdentifier} 签名的`;
  if (!quiet('/usr/sbin/spctl', ['-a', '-t', 'exec', app]).ok) return 'macOS 的 Gatekeeper 没有放行（没有公证？）';
  return undefined;
}
const versionOf = app => quiet('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(app, 'Contents', 'Info.plist')]).out.trim();
const sha256 = async file => { const hash = createHash('sha256'); await pipeline(createReadStream(file), hash); return hash.digest('hex'); };

if (process.platform !== 'darwin') stop('这一版只有 macOS 的电脑驱动。');
// `--from` names a file; without one it is a mistake, not a reason to download.
if (args.includes('--from') && (!value('--from') || value('--from').startsWith('--'))) stop('用法：npm run computer:install -- --from <压缩包的路径>');
const current = existsSync(installed) ? { version: versionOf(installed), problem: refusal(installed) } : undefined;
if (args.includes('--check')) {
  console.log(!current ? `还没有安装（会装到 ${installed}）。` : current.problem ? `${installed} 不能用：${current.problem}。` : `已安装 ${current.version}（固定版本 ${lock.version}）：${installed}`);
  process.exit(current && !current.problem ? 0 : 1);
}
if (current && !current.problem && current.version === lock.version) { console.log(`已经是固定的 ${lock.version}：${installed}`); process.exit(0); }

mkdirSync(tools, { recursive: true });
const work = mkdtempSync(join(tools, '.install-'));
// Set when the work directory holds the only copy of the old driver: then it is not cleared away.
let keep = false;
try {
  let archive = value('--from') ? resolve(value('--from')) : undefined;
  if (archive && !existsSync(archive)) refuse(`找不到 ${archive}`);
  if (!archive) {
    archive = join(work, lock.darwin.asset);
    const url = `${lock.repository}/releases/download/${lock.tag}/${lock.darwin.asset}`;
    console.log(`下载 ${url}（约 ${Math.round(lock.darwin.bytes / 1e6)} MB）…`);
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) refuse(`下载失败：HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
  }
  if (statSync(archive).size !== lock.darwin.bytes) refuse(`文件大小不对（${statSync(archive).size}，应为 ${lock.darwin.bytes}），没有安装。`);
  const digest = await sha256(archive);
  if (digest !== lock.darwin.sha256) refuse(`校验和不对，没有安装。\n  得到 ${digest}\n  应为 ${lock.darwin.sha256}`);
  // Only the app is taken out of the archive.
  const unpacked = join(work, 'unpacked'); mkdirSync(unpacked);
  const tar = quiet('/usr/bin/tar', ['-xzf', archive, '-C', unpacked, '--strip-components=1', lock.darwin.app]);
  if (!tar.ok) refuse(`解包失败：${tar.err.trim()}`);
  const fresh = join(unpacked, 'CuaDriver.app'), problem = refusal(fresh);
  if (problem) refuse(`解出来的应用不能用：${problem}。没有安装。`);
  if (versionOf(fresh) !== lock.version) refuse(`应用的版本是 ${versionOf(fresh)}，不是固定的 ${lock.version}。没有安装。`);
  // The old copy is set aside only after the new one passed every check, and comes back if the new one cannot take its place.
  // (Stopped between the two moves, the old copy is still there: in this run's work directory under tools/, named previous.app.)
  const previous = existsSync(installed) ? join(work, 'previous.app') : undefined;
  if (previous) renameSync(installed, previous);
  try { renameSync(fresh, installed); }
  catch (error) {
    if (!previous) refuse(`没能放到 ${installed}：${error.message}。`);
    try { renameSync(previous, installed); }
    catch { keep = true; refuse(`没能放到 ${installed}：${error.message}。原来的那份也没能放回去，它在 ${previous}，请手动移回。`); }
    refuse(`没能放到 ${installed}：${error.message}。原来的那份还在。`);
  }
  console.log(`已安装 cua-driver ${lock.version}：${installed}\n在一只猫的资料里打开「电脑」，macOS 会请你给 CuaDriver 两项授权（辅助功能、屏幕录制）。`);
} catch (error) {
  if (!(error instanceof Refused)) throw error;
  console.error(error.message); process.exitCode = 1;
} finally { if (!keep) rmSync(work, { recursive: true, force: true }); }
