'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { temporary, script, repository } = require('./helpers');
const { changeUrl, readPatch, GerritPatches } = require('../src/gerrit-patches');
const origin = 'https://review.whamcloud.com';
const info = { change_number: 64086, subject: 'LU-12345 lod: fix allocation', owner: 'Test Author',
  project: 'fs/lustre-release', branch: 'master', current_patchset: 3, current_revision: 'a'.repeat(40),
  patchsets: [{number:1},{number:2},{number:3}], other: 'not needed in UI' };

test('Gerrit patch URLs require the exact HTTPS host and a change number', () => {
  for (const route of ['/64086', '/c/64086/', '/c/fs/lustre-release/+/64086', '/#/c/64086/']) {
    assert.deepEqual(changeUrl(origin+route), { number:64086, patchset:undefined, url:origin+'/64086' });
  }
  for (const route of ['/64086/2', '/c/fs/lustre-release/+/64086/2/file.c#12', '/#/c/64086/2']) {
    assert.equal(changeUrl(origin+route).patchset, 2);
  }
  for (const input of ['', null, 64086, origin, origin+'/', 'http://review.whamcloud.com/64086',
    origin+'.evil.test/64086', 'https://review.whamcloud.com@evil.test/64086',
    'https://user:pass@review.whamcloud.com/64086', 'https://review.whamcloud.com:8443/64086',
    origin+'/q/status:open', origin+'/0', origin+'/9007199254740992', origin+'/64086/9007199254740992',
    origin+'/64086\n', origin+'\\@evil.test/64086', 'file:///64086']) {
    assert.throws(() => changeUrl(input), /Enter a Gerrit change URL/);
  }
});

test('patch lookup uses only info on the allowed server and validates the returned change/patchset', async t => {
  const dir = await temporary(t);
  const cli = await script(dir, 'gerrit', `
    const fs=require('fs'),path=require('path');
    fs.writeFileSync(path.join(__dirname,'request.json'),JSON.stringify({args:process.argv.slice(2),server:process.env.GERRIT_URL}));
    console.log(JSON.stringify(${JSON.stringify(info)}));
  `);
  const patch = await readPatch(cli, origin+'/c/fs/lustre-release/+/64086?ignored=--post-comments', dir);
  assert.equal(patch.subject,info.subject); assert.equal(patch.owner,info.owner);
  assert.equal(patch.patchset,3); assert.equal(patch.revision,info.current_revision);
  assert.equal(patch.url,origin+'/64086/3'); assert.equal(patch.other,undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'request.json'),'utf8')),
    {args:['info',origin+'/64086'],server:origin});
  const old = await readPatch(cli, origin+'/64086/2', dir);
  assert.equal(old.patchset,2); assert.equal(old.revision,undefined,'do not mislabel an old patchset with the current SHA');
  await assert.rejects(readPatch(cli,origin+'/64086/4',dir),/Patchset 4 does not exist/);
  await assert.rejects(readPatch(cli,origin+'/64087',dir),/unexpected patch details/);
});

test('patch lookup hides raw errors, handles timeouts, and refuses invalid URLs before launching the CLI', async t => {
  const dir = await temporary(t);
  const cli = await script(dir, 'gerrit', `console.log('GERRIT_PASS=secret');console.error('private response');process.exit(2);`);
  await assert.rejects(readPatch(cli,origin+'/64086',dir), e => /authentication failed/.test(e.message) && !/secret|private response/.test(e.message));
  const stalled = await script(dir,'stalled','setInterval(()=>{},1000);');
  await assert.rejects(readPatch(stalled,origin+'/64086',dir,{timeout:50}),/timed out/);
  const invalid = await script(dir,'invalid','console.log("private invalid JSON");');
  await assert.rejects(readPatch(invalid,origin+'/64086',dir),/returned invalid JSON/);
  await assert.rejects(readPatch('/does/not/exist',origin+'.evil.test/64086',dir),/Enter a Gerrit change URL/);
});

test('patch preparation list rejects duplicates and starts empty on reload', async t => {
  const repo = await repository(t), dir = repo.directory;
  repo.git('remote','add','origin',origin+'/fs/lustre-release');
  const cli = await script(dir, 'gerrit', `console.log(JSON.stringify(${JSON.stringify(info)}));`);
  const saved = new Map();
  const options = { storage:{get:(key,fallback)=>saved.get(key)??fallback,update:async(key,value)=>saved.set(key,value)},
    find:async()=>cli, cwd:()=>dir, changed:()=>{} };
  const list = new GerritPatches(options);
  await list.add(origin+'/64086');
  assert.equal(list.get().items.length,1); assert.equal(list.get().error,false);
  assert.equal(list.get().addedUrl,origin+'/64086');
  await list.add(origin+'/c/fs/lustre-release/+/64086/2');
  assert.match(list.get().message,/already in the list/); assert.equal(list.get().items.length,1);
  await list.add(origin+'/64087');
  assert.equal(list.get().error,true); assert.equal(list.get().items.length,1);
  const restored = new GerritPatches(options);
  assert.deepEqual(restored.get().items,[]);
  await list.remove(64086);
  assert.equal(list.get().items.length,0);
  assert.equal(new GerritPatches(options).get().items.length,0);
  saved.set('gerritPatches',[{url:origin+'.evil.test/64086'},null]);
  assert.equal(new GerritPatches(options).get().items.length,0);
  saved.set('gerritPatches',{});
  assert.equal(new GerritPatches(options).get().items.length,0);
});

test('adding rejects a patch from another project, even when its URL claims the current project', async t => {
  const repo=await repository(t);
  repo.git('remote','add','origin','ssh://user@review.whamcloud.com:29418/ex/lustre-release');
  repo.git('remote','add','upstream',origin+'/fs/lustre-release');
  const cli=await script(repo.directory,'gerrit',`console.log(JSON.stringify(${JSON.stringify(info)}));`);
  const list=new GerritPatches({find:async()=>cli,cwd:()=>repo.directory,changed:()=>{}});
  await list.add(origin+'/c/ex/lustre-release/+/64086');
  assert.equal(list.get().error,true);
  assert.equal(list.get().items.length,0);
  assert.match(list.get().message,/belongs to "fs\/lustre-release".*current repository is "ex\/lustre-release"/);
  repo.git('remote','set-url','origin',origin+'/fs/lustre-release');
  await list.add(origin+'/64086');
  assert.equal(list.get().error,false);
  assert.equal(list.get().items.length,1);
  list.setRepository('/new/repository');
  assert.equal(list.get().items.length,0);
});

test('repository switching cancels a lookup before it can add an old repository’s patch', async () => {
  let release,cwd='/repo-a';
  const list=new GerritPatches({find:async()=>'/gerrit',cwd:()=>cwd,changed:()=>{},
    read:async()=>new Promise(resolve=>{release=resolve;})});
  const pending=list.add(origin+'/64086');
  while(!release) await new Promise(resolve=>setImmediate(resolve));
  cwd='/repo-b';list.setRepository(cwd);
  release(info);await pending;
  assert.deepEqual(list.get().items,[]);
  assert.equal(list.get().pending,false);
  assert.equal(list.get().error,false);
});

test('clearing a queue cancels pending lookups and ignores late responses', async () => {
  let release;
  const list = new GerritPatches({ find:async()=>'/gerrit',cwd:()=>'/repo',changed:()=>{},
    read:async()=>new Promise(resolve=>{release=resolve;}) });
  const pending = list.add(origin+'/64086');
  while (!release) await new Promise(resolve=>setImmediate(resolve));
  list.clear();
  assert.equal(list.get().pending,false);
  release({number:64086}); await pending;
  assert.deepEqual(list.get().items,[]);
  assert.equal(list.get().message,'');
});

test('pending lookups do not overlap and disposal cancels without adding a patch', async () => {
  let release, signal, writes = 0, reads = 0;
  const list = new GerritPatches({ storage:{get:()=>[],update:async()=>writes++},find:async()=>'/gerrit',cwd:()=>'/repo',changed:()=>{},
    read:async (_binary,_url,_cwd,options)=>{ reads++; signal=options.signal; return new Promise(resolve=>{release=resolve;}); } });
  const pending = list.add(origin+'/64086');
  while (!release) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(list.get().pending,true);
  await list.add(origin+'/64087'); assert.equal(reads,1);
  list.dispose(); assert.equal(signal.aborted,true);
  release({number:64086}); await pending;
  assert.equal(writes,0); assert.equal(list.get().items.length,0);
});

test('changes ticked in the review lists are read in parallel, and a failure names its change', async t => {
  const repo = await repository(t);
  repo.git('remote', 'add', 'origin', 'https://review.whamcloud.com/fs/lustre-release');
  let release; const gate = new Promise(resolve => { release = resolve; });
  const reads = [], updates = [];
  const patches = new GerritPatches({ find: async () => 'gerrit', cwd: () => repo.directory, changed: () => updates.push(patches.get()),
    read: async (binary, url, cwd, { signal }) => {
      reads.push(url); await gate;
      if (signal.aborted) throw new Error('Reading the Gerrit patch was cancelled.');
      const number = Number(url.split('/').pop());
      if (number === 3) throw new Error('Patch not found or not accessible to your Gerrit account.');
      return { number, url: `${origin}/${number}/1`, patchset: 1, subject: `Change ${number}`, owner: 'Owner',
        project: number === 4 ? 'other/project' : 'fs/lustre-release', branch: 'master' };
    } });
  const all = [patches.addChange(1), patches.addChange(2), patches.addChange(3), patches.addChange(1), patches.addChange(4)];
  assert.deepEqual(patches.get().adding.sort(), [1, 2, 3, 4]);
  await patches.add(`${origin}/2`);
  assert.match(patches.get().message, /already in the list/, 'a pasted URL of a change being added is refused');
  release(); await Promise.all(all);
  assert.deepEqual(patches.get().items.map(item => item.number).sort(), [1, 2]);
  assert.deepEqual(reads.sort(), [`${origin}/1`, `${origin}/2`, `${origin}/3`, `${origin}/4`]);
  assert.deepEqual(patches.get().adding, []);
  assert.equal(patches.get().error, true);
  assert.match(patches.get().message, /^Change #(3|4): /);
  await patches.addChange(1);
  assert.equal(reads.length, 4, 'a change already in the list is not read again');
  await patches.addChange(0); await patches.addChange(1.5);
  assert.equal(reads.length, 4);

  // Clearing the list abandons changes still being read.
  let hold; const held = new Promise(resolve => { hold = resolve; });
  const slow = new GerritPatches({ find: async () => 'gerrit', cwd: () => repo.directory, changed: () => {},
    read: async () => { await held; return { number: 9, url: `${origin}/9/1`, patchset: 1, subject: 'Late', project: 'fs/lustre-release' }; } });
  const late = slow.addChange(9);
  slow.clear();
  hold(); await late;
  assert.deepEqual(slow.get().items, []);
});
