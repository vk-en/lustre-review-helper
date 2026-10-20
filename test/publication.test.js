'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ReviewService } = require('../src/service');
const { GerritPublication, postTarget } = require('../src/publication');
const { gerritTarget } = require('../src/review-targets');
const { reviewSignature, signedReport } = require('../src/signature');
const { temporary, script } = require('./helpers');

async function setup(t, mode = 'full') {
  const root = await temporary(t), id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const directory = path.join(root, 'runs', id, 'artifacts');
  await fs.mkdir(directory, { recursive: true });
  const service = new ReviewService({ storage: path.join(root, 'runs'), signature: run => reviewSignature('Lustre Bot', run, true) });
  service.setRepositories([root]);
  const patch = gerritTarget({ number:64086, patchset:2, project:'fs/lustre-release', url:'https://review.whamcloud.com/64086/2' });
  const key = patch.id, manifestKey = '64086' + (mode === 'light' ? '-light' : '');
  const run = { id, repository:service.repositories[0].id, repo:root, status:'completed', commits:[key],
    gerritPatches:[patch], model:'opus', modelName:'Opus', effort:'max', mode,
    results:[{sha:'a'.repeat(40), target:key, status:'findings'}] };
  service.runs.set(id, run);
  const summary = { [manifestKey]: { local:false, number:64086, patchset:2, sha:'a'.repeat(40),
    repository:'fs/lustre-release', provider:'gerrit', base_url:'https://review.whamcloud.com', mode,
    status:'findings', json:'review.json', markdown:'review.md' },
    '64087': { local:false, number:64087, patchset:1, sha:'b'.repeat(40), status:'clean' } };
  const save = () => fs.writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary));
  await save();
  await fs.writeFile(path.join(directory,'review.json'), JSON.stringify({message:'Assessment',comments:{'file.c':[{line:2,message:'(defect) Check this'}]}}));
  await fs.writeFile(path.join(directory,'review.md'), '# Review\n\n## Overall assessment\n\nAssessment\n\n## Findings\n\nFinding');
  return { root, id, key, manifestKey, directory, service, run, summary, save };
}

test('a report signed in bold by an earlier version becomes plain once, keeping the assessment', () => {
  const old = '# Review\n\n## Overall assessment\n\n**\\[Bot\\]**\n\nExisting assessment\n\n## Findings\n\nDetails';
  const converted = signedReport(old, '[Bot]');
  assert.equal(converted, '# Review\n\n## Overall assessment\n\n\\[Bot\\]\n\nExisting assessment\n\n## Findings\n\nDetails');
  assert.equal(signedReport(converted, '[Bot]'), converted);
});

test('report signatures preserve the assessment, appear first and remain idempotent', () => {
  const signature = reviewSignature('Bot', { model:'opus',effort:'max' }, true);
  assert.equal(signature,'[Bot - opus - max]');
  assert.equal(reviewSignature('',{model:'test'},true),'[AI review - test - Default]');
  assert.equal(reviewSignature('Bot',{model:'opus',effort:'max'}),'[Bot]');
  assert.equal(reviewSignature('',{model:'opus',effort:'max'}),'[AI review]');
  for (const original of ['# Review\n\n## Overall assessment\n\nExisting assessment\n\n## Findings\n\nDetails', '# Clean\n\n## Findings\n\nNo issues', '# Legacy']) {
    const result = signedReport(original,signature);
    assert.match(result,/## Overall assessment\n\n\\\[Bot - opus - max\\\]\n/);
    assert.ok(!result.includes('**'), 'the signature is not bold');
    assert.equal(signedReport(result,signature),result);
    if (original.includes('Existing assessment')) assert.ok(result.indexOf('Bot - opus') < result.indexOf('Existing assessment'));
  }
});

test('publication targets one exact manifest key, uses the saved signature and prevents repeats', async t => {
  for (const mode of ['full','light']) {
    const f = await setup(t,mode);
    const binary = await script(f.root,'fake-post', `
      const fs=require('fs'),path=require('path'),args=process.argv.slice(2);
      if(args[0]!=='post'||args.includes('--force')||args.includes('--post'))process.exit(2);
      fs.appendFileSync(path.join(__dirname,'calls'),JSON.stringify(args)+'\\n');
      const file=path.join(args[args.indexOf('--results-dir')+1],'summary.json');
      const summary=JSON.parse(fs.readFileSync(file));summary[args[1]].posted=true;
      fs.writeFileSync(file,JSON.stringify(summary));
    `);
    const publication = new GerritPublication({service:f.service,find:async()=>binary});
    await publication.refresh(f.id,f.key);
    assert.equal(publication.get(f.id,f.key).status,'ready');
    await f.service.reportFiles(f.id,f.key);
    f.service.signature = () => '[Wrong current settings]';
    await Promise.all([publication.publish(f.id,f.key),publication.publish(f.id,f.key)]);
    assert.equal(publication.get(f.id,f.key).status,'posted');
    await publication.publish(f.id,f.key);
    const calls = (await fs.readFile(path.join(f.root,'calls'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls,[['post',f.manifestKey,'--results-dir',f.directory,'--prefix','[Lustre Bot - Opus - max]']]);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.directory,'summary.json'),'utf8'))['64087'].posted,undefined);
    const restored = new GerritPublication({service:f.service,find:async()=>binary});
    await restored.refresh(f.id,f.key);
    assert.equal(restored.get(f.id,f.key).status,'posted');
    assert.equal(restored.get(f.id,f.key).postedAt,f.run.publications[f.key].updatedAt,'falls back to the confirmed publication time');
    const posted = JSON.parse(await fs.readFile(path.join(f.directory,'summary.json'),'utf8'));
    posted[f.manifestKey].posted_at='2026-10-16T15:19:25+00:00';
    await fs.writeFile(path.join(f.directory,'summary.json'),JSON.stringify(posted));
    await restored.refresh(f.id,f.key);
    assert.equal(restored.get(f.id,f.key).postedAt,'2026-10-16T15:19:25+00:00','lreview records the publication time');
  }
});

test('publication refuses mismatched revisions, hosts, statuses, providers and escaping artifacts', async t => {
  const f=await setup(t);
  const original={...f.summary[f.manifestKey]};
  for (const change of [{local:true},{number:1},{patchset:3},{sha:'b'.repeat(40)}, {provider:'github'},
    {base_url:'https://other.example'}, {repository:'other/project'}, {mode:'light'}, {status:'failed'}]) {
    f.summary[f.manifestKey]={...original,...change};await f.save();
    await assert.rejects(postTarget(f.service,f.id,f.key),/does not match/);
  }
  await fs.writeFile(path.join(f.root,'outside.json'),'{}');
  await fs.symlink(path.join(f.root,'outside.json'),path.join(f.directory,'escape.json'));
  f.summary[f.manifestKey]={...original,json:'escape.json'};await f.save();
  await assert.rejects(postTarget(f.service,f.id,f.key),/escapes/);
  await assert.rejects(postTarget(f.service,f.id,'a'.repeat(40)),/Only Gerrit/);
  f.run.status='running';
  await assert.rejects(postTarget(f.service,f.id,f.key),/Wait/);
  f.run.status='cancelled';f.run.results[0].status='cancelled';
  await assert.rejects(postTarget(f.service,f.id,f.key),/no completed review/);
});

test('publication supports clean results and successful patches in a partially failed batch', async t => {
  const f=await setup(t);
  f.run.status='failed';f.run.results[0].status='clean';
  f.summary[f.manifestKey].status='clean';delete f.summary[f.manifestKey].json;await f.save();
  const target=await postTarget(f.service,f.id,f.key);
  assert.equal(target.entry.status,'clean');
});

test('failed and unconfirmed publication never claims success or exposes raw CLI diagnostics', async t => {
  const f=await setup(t);
  const binary=await script(f.root,'failed-post',"console.error('GERRIT_PASS=secret');process.exit(1)");
  const publication=new GerritPublication({service:f.service,find:async()=>binary});
  await assert.rejects(publication.publish(f.id,f.key),e=>/Could not publish/.test(e.message)&&!e.message.includes('secret'));
  assert.equal(publication.get(f.id,f.key).status,'error');
  assert.equal(f.run.publications[f.key].status,'error');
  const unconfirmed=new GerritPublication({service:f.service,find:async()=>binary,execute:async()=>{}});
  await assert.rejects(unconfirmed.publish(f.id,f.key),/not confirmed/);
  assert.equal(unconfirmed.get(f.id,f.key).status,'unknown');
  const restored=new GerritPublication({service:f.service,find:async()=>binary});
  await restored.refresh(f.id,f.key);
  assert.equal(restored.get(f.id,f.key).status,'unknown');
  await assert.rejects(restored.publish(f.id,f.key),/uncertain/);
});
