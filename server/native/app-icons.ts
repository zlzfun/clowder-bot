import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The picture an app is recognised by, taken from the program installed on this computer — the same icon the
 * Dock shows, read from that program's own bundle. Nothing of a third party's artwork is kept in this repository
 * or in the data directory; where the program is not installed there is no picture and the page draws its own mark.
 */
export interface AppIcons {
  /** Changes when the picture does, so its address can be cached; undefined when there is none. */
  wechatMark(): Promise<string | undefined>;
  /** PNG bytes, or undefined. */
  wechat(): Promise<Buffer | undefined>;
}
export const noIcons: AppIcons = { wechatMark: async () => undefined, wechat: async () => undefined };

const run = (file: string, args: string[], timeout = 8000) =>
  new Promise<{ ok: boolean; out: string }>(done => execFile(file, args, { timeout, maxBuffer: 1 << 20 }, (error, stdout) => done({ ok: !error, out: String(stdout) })));

/** macOS: 微信's bundle in the two places applications live; its icon file is named by its own Info.plist. */
export function macAppIcons(platform: string = process.platform, home: string = homedir()): AppIcons {
  if (platform !== 'darwin') return noIcons;
  const bundles = ['/Applications/WeChat.app', join(home, 'Applications', 'WeChat.app')];
  let made: { mark: string; png: Buffer } | undefined;
  async function source(): Promise<{ file: string; mark: string } | undefined> {
    for (const bundle of bundles) {
      const named = await run('/usr/bin/plutil', ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist')]);
      const name = named.ok ? named.out.trim() : '';
      // A name from the bundle is a file name, nothing more: no path may come out of it.
      if (!name || !/^[\w .-]{1,80}$/.test(name) || name.includes('..')) continue;
      const file = join(bundle, 'Contents', 'Resources', name.endsWith('.icns') ? name : `${name}.icns`);
      try { const found = await stat(file); if (found.isFile()) return { file, mark: `${found.size.toString(36)}${Math.round(found.mtimeMs).toString(36)}` }; } catch { /* next place */ }
    }
    return undefined;
  }
  return {
    async wechatMark() { return (await source())?.mark; },
    async wechat() {
      const from = await source();
      if (!from) return undefined;
      if (made?.mark === from.mark) return made.png;
      const dir = await mkdtemp(join(tmpdir(), 'clowder-bot-icon-'));
      try {
        const out = join(dir, 'icon.png');
        const converted = await run('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '256', from.file, '--out', out], 15_000);
        if (!converted.ok) return undefined;
        const png = await readFile(out);
        // Only a real PNG goes out under that content type.
        if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) return undefined;
        made = { mark: from.mark, png };
        return png;
      } catch { return undefined; }
      finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
    },
  };
}
