import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { guardPlan, guardProfile, directoryList, nativeStateFiles } from './file-guard.mjs';

test('guard refuses broad writable roots and invalid read grants',()=>{
  assert.throws(()=>guardProfile({writable:'/'}),/refuses/);
  assert.throws(()=>guardProfile({writable:homedir()}),/refuses/);
  assert.throws(()=>directoryList('["relative"]'),/absolute/);
});
test('native state exceptions are exact files, with no config-directory write grant',t=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'clowder-native-state-')));mkdirSync(join(home,'.codex'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  for(const name of ['state_5.sqlite','installation_id','auth.json','config.toml'])writeFileSync(join(home,'.codex',name),'test');
  const files=nativeStateFiles(home);
  assert.ok(files.includes(join(home,'.codex/state_5.sqlite-wal')));
  assert.ok(files.includes(join(home,'.codex/installation_id')));
  assert.ok(!files.some(p=>p.endsWith('auth.json')||p.endsWith('config.toml')));
});
test('OS boundary blocks external writes, links, renames and descendants; allows independent copies',{skip:process.platform!=='darwin'},t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'clowder-file-guard-'))),work=join(root,'work'),source=join(root,'source');
  mkdirSync(work);mkdirSync(source);writeFileSync(join(source,'original.txt'),'original');writeFileSync(join(root,'unapproved.txt'),'private');
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const program=`const fs=require('node:fs'),cp=require('node:child_process');const work=${JSON.stringify(work)},source=${JSON.stringify(source)};
  const denied=[];const reject=(name,fn)=>{try{fn();throw Error('UNEXPECTED_SUCCESS:'+name);}catch(e){if(!['EPERM','EACCES','EROFS'].includes(e.code))throw e;denied.push(name);}};
  reject('overwrite',()=>fs.writeFileSync(source+'/original.txt','bad'));
  reject('create',()=>fs.writeFileSync(source+'/created.txt','bad'));
  reject('remove',()=>fs.unlinkSync(source+'/original.txt'));
  reject('rename',()=>fs.renameSync(source+'/original.txt',work+'/stolen.txt'));
  fs.symlinkSync(source+'/original.txt',work+'/linked.txt');reject('symlink-write',()=>fs.writeFileSync(work+'/linked.txt','bad'));
  reject('hardlink',()=>fs.linkSync(source+'/original.txt',work+'/hard.txt'));
  reject('unapproved-read',()=>fs.readFileSync(${JSON.stringify(join(root,'unapproved.txt'))}));
  const child=cp.spawnSync(process.execPath,['-e','require("node:fs").writeFileSync('+JSON.stringify(source+'/child.txt')+',"bad")']);if(child.status===0)throw Error('child escaped');
  fs.copyFileSync(source+'/original.txt',work+'/copy.txt');fs.writeFileSync(work+'/copy.txt','edited');
  if(fs.readFileSync(source+'/original.txt','utf8')!=='original')throw Error('source changed');console.log(JSON.stringify({denied,childBlocked:true,copy:'edited'}));`;
  const plan=guardPlan(process.execPath,['-e',program],{writable:work,readable:[source]});
  const r=spawnSync(plan.command,plan.args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).denied.length,7);
  assert.equal(readFileSync(join(source,'original.txt'),'utf8'),'original');assert.equal(readFileSync(join(work,'copy.txt'),'utf8'),'edited');
});
