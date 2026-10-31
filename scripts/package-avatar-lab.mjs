import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const folder = resolve(root, 'client/public/avatar-lab');
const source = readFileSync(resolve(folder, 'lab.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(0, source.indexOf('let active')) + ';globalThis.metadata={cats,styles};', context);
const { cats, styles } = context.metadata;
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const collections = styles.map(style => {
  const result = { ...style, status: style.group === 'active' ? 'active' : 'shortlisted', avatars: [] };
  if (style.format === 'PNG') {
    result.sheet = `sheets/${style.id}.png`;
    const file = resolve(folder, result.sheet);
    const bytes = readFileSync(file);
    if (bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error(`Not PNG: ${file}`);
    result.width = bytes.readUInt32BE(16);
    result.height = bytes.readUInt32BE(20);
    result.columns = 4;
    result.rows = 2;
    if (Math.abs(result.width / result.height - 2) > .01) throw new Error(`Sheet must be 2:1: ${file}`);
    result.sha256 = digest(file);
  }
  result.avatars = cats.map(([id, name], index) => {
    const avatar = { id, name, code: style.code + String(index + 1).padStart(2, '0') };
    if (style.format === 'SVG') {
      avatar.path = `sets/${style.id}/${id}.svg`;
      const file = resolve(folder, avatar.path);
      if (!existsSync(file) || !statSync(file).size) throw new Error(`Missing asset: ${file}`);
      avatar.sha256 = digest(file);
    } else {
      avatar.column = index % 4;
      avatar.row = Math.floor(index / 4);
    }
    return avatar;
  });
  return result;
});
writeFileSync(resolve(folder, 'manifest.json'), JSON.stringify({
  version: 3,
  title: 'clowder-bot 猫猫头像 · 已选方案',
  updated: '2026-10-31',
  activeStyle: 'clay',
  interfaceTheme: 'cat-cafe',
  selectedAvatarCount: cats.length * styles.length,
  previousRounds: ['round-1.html', 'round-2.html'],
  characters: cats.map(([id, name, breed, role]) => ({ id, name, breed, role })),
  collections,
  usage: 'The three selected PNG collections use a 4-column, 2-row grid. The app currently uses clay (3D toy portraits) with the cat-cafe palette. Earlier studies are archived and remain included in the bundle.'
}, null, 2) + '\n');

execFileSync('python3', ['-c', `
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
root=Path(${JSON.stringify(folder)})
with ZipFile(root/'avatar-collection.zip', 'w', ZIP_DEFLATED) as z:
    for path in sorted(root.rglob('*')):
        if path.is_file() and path.suffix in {'.svg','.png','.html','.css','.js','.json'}:
            z.write(path, 'avatar-lab/'+str(path.relative_to(root)))
    for path in sorted(Path(${JSON.stringify(resolve(root, 'scripts'))}).glob('avatar-lab-*.mjs')):
        z.write(path, 'generators/'+path.name)
with ZipFile(root/'avatar-collection.zip') as z:
    assert z.testzip() is None
    print(f'Packaged {len(z.namelist())} files; ZIP integrity verified.')
`], { stdio: 'inherit' });
console.log(`Validated ${styles.length} selected collections, ${cats.length * styles.length} avatars; active: clay.`);
