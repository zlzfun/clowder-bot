/** Host filesystem boundary. No model/provider/orchestration state is owned here. */
import { existsSync, mkdirSync, realpathSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, delimiter } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const within = (root, path) => { const part = relative(root, path); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('../')); };
const canonical = path => realpathSync(path);
const quote = value => JSON.stringify(value);
const rule = (kind, paths) => paths.length ? `(${kind} ${paths.map(p => `(subpath ${quote(p)})`).join(' ')})` : '';
export function directoryList(value = '[]') {
  const paths = JSON.parse(value);
  if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !isAbsolute(p))) throw new Error('Read-only directories must be an array of absolute paths.');
  return [...new Set(paths.map(canonical))];
}
export function guardProfile({ writable, readable = [], home = homedir(), privateState = [], stateFiles = [] }) {
  const root = canonical(writable), userHome = canonical(home);
  if (within(root,userHome) || root === '/') throw new Error('File guard refuses a writable home or filesystem root.');
  const writes = [...new Set([root, ...privateState.map(canonical)])];
  if (writes.some(p => p === '/' || within(p,userHome))) throw new Error('File guard state directory is too broad.');
  const reads = [...new Set([...writes, ...readable.map(canonical)])];
  // User data needs an explicit read grant. OS libraries/toolchains remain readable.
  // Kernel checks also apply to descendant processes and symlink targets.
  return ['(version 1)', '(allow default)', '(deny file-write*)',
    // macOS ps is setuid; native process ownership probes need this fixed read-only OS binary.
    '(allow process-exec (literal "/bin/ps") (with no-sandbox))',
    rule('allow file-write*',writes),
    ...(stateFiles.length ? [`(allow file-write* ${stateFiles.map(p => `(literal ${quote(p)})`).join(' ')})`] : []),
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$"))',
    `(deny file-read-data (subpath ${quote(userHome)}) (subpath "/Volumes") (subpath "/private/tmp") (subpath "/tmp") (subpath ${quote(canonical(tmpdir()))}))`,
    rule('allow file-read-data',reads),
  ].join('\n');
}
/** Permit only existing native SQLite families and their journal companions, not the config directory. */
export function nativeStateFiles(home = homedir()) {
  const dir=join(home,'.codex'); if(!existsSync(dir))return [];
  const files=[];
  const installation=join(dir,'installation_id');
  if(existsSync(installation)) {
    if(lstatSync(installation).isSymbolicLink() || !lstatSync(installation).isFile())throw new Error('Native installation state must be a regular file.');
    files.push(canonical(installation));
  }
  for(const name of readdirSync(dir)) {
    if(!/^(?:state|logs|thread_history|queue|memories|goals)_\d+\.sqlite$/.test(name))continue;
    for(const suffix of ['','-wal','-shm','-journal']) {
      const full=join(dir,name+suffix);
      if(existsSync(full) && (lstatSync(full).isSymbolicLink() || !lstatSync(full).isFile()))throw new Error('Native SQLite state must be a regular file.');
      files.push(join(canonical(dir),name+suffix));
    }
  }
  return files;
}
export function guardPlan(command, args, options) {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) throw new Error('当前平台尚未验证文件保护，已拒绝无保护执行；本版支持 macOS。');
  return { command:'/usr/bin/sandbox-exec', args:['-p',guardProfile(options),command,...args] };
}
/** Only native operational state is writable outside the business cwd; never account configuration. */
export function nativeStatePaths(data, home = homedir()) {
  const base = join(data,'agent-state'); mkdirSync(base,{recursive:true,mode:0o700});
  const paths = [base];
  for (const p of ['.claude/projects','.claude/debug','.claude/todos','.claude/tasks','.claude/sessions','.claude/session-env','.claude/shell-snapshots','.local/state/claude/locks',
    '.codex/sessions','.codex/archived_sessions','.codex/log','.codex/logs','.codex/tmp','.codex/shell_snapshots','.codex/thread-writer-locks',
    '.kimi/sessions','.kimi/logs']) {
    const full=join(home,p); if (existsSync(full)) { if(lstatSync(full).isSymbolicLink()) throw new Error(`Agent state must not be redirected: ${p}`);paths.push(canonical(full)); }
  }
  return paths;
}
export function nativeReadPaths(repo, data, home = homedir()) {
  const paths=[repo,data];
  // Generated native checkout references only the pinned upstream object store.
  const gitLink=join(repo,'upstream/clowder-ai/.git');
  if(existsSync(gitLink) && lstatSync(gitLink).isFile()) {
    const target=/^gitdir: (.+)$/m.exec(readFileSync(gitLink,'utf8'))?.[1];
    if(target && existsSync(target))paths.push(canonical(target));
  }
  for (const p of ['.claude','.claude.json','.codex','.kimi','.local/bin','.local/share/claude','.npm','.nvm','.cache/node',
    // User-approved read-only paths for the native CLI's existing macOS login.
    'Library/Keychains/login.keychain-db','Library/Preferences/com.apple.security.plist']) {
    const full=join(home,p);if(existsSync(full))paths.push(canonical(full));
  }
  for (const key of ['NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','REQUESTS_CA_BUNDLE']) {
    const p=process.env[key]; if(p && isAbsolute(p) && existsSync(p))paths.push(canonical(p));
  }
  for (const p of (process.env.PATH ?? '').split(delimiter)) if(p && existsSync(p)) paths.push(canonical(p));
  return [...new Set(paths)];
}

async function main() {
  const [scope,cwd,separator,...command]=process.argv.slice(2);
  if (scope !== 'native' || separator!=='--' || !command.length) throw new Error('Invalid file guard invocation.');
  const data=canonical(process.env.CAT_CAFE_BOT_GUARD_DATA ?? '');
  const root=canonical(cwd);
  const state=nativeStatePaths(data);
  const temp=join(data,'agent-state','tmp');mkdirSync(temp,{recursive:true,mode:0o700});
  const readable=[...nativeReadPaths(resolve(import.meta.dirname,'..'),data),...directoryList(process.env.CAT_CAFE_BOT_READ_ONLY_DIRS ?? '[]')];
  const plan=guardPlan(command[0],command.slice(1),{writable:data,privateState:state,stateFiles:nativeStateFiles(),readable});
  const child=spawn(plan.command,plan.args,{cwd:root,env:{...process.env,TMPDIR:temp,TMP:temp,TEMP:temp,TMPPREFIX:join(temp,'zsh'),CLAUDE_CODE_TMPDIR:temp,CAT_CAFE_BOT_FILE_GUARD_ENFORCED:'macos-seatbelt'},stdio:'inherit'});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
  child.on('error',e=>{console.error(e.message);process.exitCode=1;});
  child.on('exit',(code,signal)=>{process.exitCode=code??(signal?128:1);});
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(e=>{console.error(e.message);process.exitCode=1;});
