'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ReviewService, artifact, collectResults } = require('../src/service');
const { reviewDetails } = require('../src/review-lookup');
const { reports, summarize } = require('../src/history');
const { repository, script, temporary, until } = require('./helpers');

async function setup(t, scenario = 'findings') {
  let service;
  // Cleanup hooks run in registration order. Stop the service before removing its storage.
  t.after(() => service?.dispose());
  const repo = await repository(t);
  repo.git('remote', 'add', 'origin', 'https://review.whamcloud.com/fs/lustre-release');
  const first = await repo.commit('old\n', 'LU-1: old');
  const second = await repo.commit('new\n', 'LU-2: new');
  const binary = await script(repo.directory, 'fake-lreview', `
    const fs=require('fs'),path=require('path');
    const args=process.argv.slice(2);
    fs.writeFileSync(${JSON.stringify(path.join(repo.directory, 'invocation.json'))},JSON.stringify({args,env:{PATH:process.env.PATH,LREVIEW_EFFORT:process.env.LREVIEW_EFFORT,LREVIEW_VSCODE_WORKER:process.env.LREVIEW_VSCODE_WORKER}}));
    fs.appendFileSync(${JSON.stringify(path.join(repo.directory, 'invocations.jsonl'))},JSON.stringify(args)+'\\n');
    const scenario=${JSON.stringify(scenario)};
    if (scenario === 'manual-post') {
      const config = process.env.LREVIEW_CONFIG;
      fs.writeFileSync('worker-config.json', JSON.stringify({ config, text: fs.readFileSync(config, 'utf8'), mode: fs.statSync(config).mode & 0o777 }));
    }
    const remote=args.filter(a=>a.startsWith('https://review.whamcloud.com/'));
    if(remote.length && scenario==='gerrit-fail'){console.log('Gerrit authentication failed');process.exit(1);}
    if(scenario==='wait'||scenario==='wait-gerrit'&&remote.length) {
      process.on('SIGINT',()=>{console.log('cancelled worker');process.exit(130)});
      console.log('ready');setInterval(()=>{},1000);
    } else {
      const dest=args[args.indexOf('--results-dir')+1];
      fs.mkdirSync(dest,{recursive:true});
      const summaryFile=path.join(dest,'summary.json');
      const summary=fs.existsSync(summaryFile)?JSON.parse(fs.readFileSync(summaryFile,'utf8')):{};
      for(const sha of args.filter(a=>/^[a-f0-9]{40}$/.test(a))) {
        const failed=scenario==='runtime-error';
        summary[sha]={sha,local:true,subject:'subject',status:failed?'failed':scenario==='clean'?'clean':'findings',severity:'medium',json:sha+'.json',log:sha+'.log',error:failed?'no review-metadata.json produced':null};
        fs.writeFileSync(path.join(dest,sha+'.json'),JSON.stringify({message:'Review result',comments:{'file.c':[{line:1,message:'Check this path <script>alert(1)</script>'}]}}));
        if(failed) fs.writeFileSync(path.join(dest,sha+'.log'), 'x'.repeat(70000)+'\\nERROR missing helper\\n'+JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Cannot review: codex-code-mode-host is missing.'}})+'\\n');
      }
      for(const url of remote) {
        const match=url.match(/\\/c\\/fs\\/lustre-release\\/\\+\\/(\\d+)\\/(\\d+)$/);
        if(!match)process.exit(4);
        const number=Number(match[1]),patchset=Number(match[2]),sha=${JSON.stringify(first)},stem=number+'_ps'+patchset;
        summary[number]={sha,local:false,number,patchset,repository:'fs/lustre-release',subject:'LU-99: remote patch',status:'findings',
          json:stem+'.json',markdown:stem+'.md',log:stem+'.log',tokens:1000,cost_usd:0.25,duration_s:3};
        fs.writeFileSync(path.join(dest,stem+'.json'),JSON.stringify({message:'Remote review',comments:{'file.c':[{line:1,message:'(defect) Gerrit finding'}]}}));
        fs.writeFileSync(path.join(dest,stem+'.md'),'# Gerrit report');
      }
      if(scenario!=='missing') fs.writeFileSync(path.join(dest,'summary.json'),JSON.stringify(summary));
      console.log('finished');
    }
  `);
  service = new ReviewService({ storage: path.join(repo.directory, 'runs'),
    settings: async () => ({ lreview: binary, codex: process.execPath, mode: 'full', jobs: 2, timeout: 60 }),
    discoverModels: async () => [{ id: 'test-model', name: 'Test', isDefault: true, efforts: ['medium'] }] });
  await service.initialize();
  service.setRepositories([repo.directory]);
  return { repo, first, second, service };
}

test('upstream notes stay in the report and only actionable findings count, including in saved runs', async t => {
  const root = await temporary(t), id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', sha = 'b'.repeat(40);
  const directory = path.join(root, id, 'artifacts');
  await fs.mkdir(directory, { recursive: true });
  const comments = [{ message: '(defect) UPSTREAM: inherited', unresolved: false },
    { message: '(defect) UPSTREAM-BLOCKER: crash' }, { message: '(minor) BACKPORT: missed a change' }];
  await fs.writeFile(path.join(directory, 'summary.json'), JSON.stringify({ [sha]: { sha, local: true, status: 'findings', json: 'review.json' } }));
  await fs.writeFile(path.join(directory, 'review.json'), JSON.stringify({ comments: { 'file.c': comments } }));
  const results = await collectResults(directory, [sha]);
  assert.deepEqual(results[0].comments.map(c => c.unresolved), [false, true, true]);
  const run = { id, commits: [sha], results, status: 'completed' };
  assert.equal(summarize(run).findings.defect, 1);
  const details = await reviewDetails({ reportFiles: async () => [] }, run, reports(run)[0]);
  assert.equal(details.findings_count, 2);
  assert.deepEqual(details.findings.map(c => c.message), comments.slice(1).map(c => c.message));
  assert.equal(details.notes[0].message, comments[0].message);

  for (const c of results[0].comments) delete c.unresolved;
  await fs.writeFile(path.join(root, id, 'run.json'), JSON.stringify(run));
  const restored = new ReviewService({ storage: root });
  await restored.initialize();
  assert.deepEqual(restored.runs.get(id).results[0].comments.map(c => c.unresolved), [false, true, true]);
  await fs.unlink(path.join(directory, 'review.json'));
  await restored.initialize();
  assert.deepEqual(restored.runs.get(id).results[0].comments.map(c => c.unresolved), [false, true, true]);
});

test('selected commits are pinned, run with real argv, and returned to both clients', async t => {
  const { repo, first, second, service } = await setup(t);
  const run = await service.start({ commits: ['HEAD~1', 'HEAD', 'HEAD'], effort: 'medium', source: 'mcp' });
  await until(() => service.get(run.id).status === 'completed');
  const result = service.get(run.id);
  assert.deepEqual(result.commits, [first, second]);
  assert.equal(result.results.length, 2);
  assert.equal(result.source, 'mcp');
  assert.equal(result.results[0].comments[0].line, 1);
  const finding = await service.finding(run.id, 0, 0);
  assert.equal(finding.content, 'old\n');
  assert.match(finding.message, /<script>/); // UI renders this as text, never HTML.
  const invocation = JSON.parse(await fs.readFile(path.join(repo.directory, 'invocation.json'), 'utf8'));
  assert.ok(invocation.args.includes('--local'));
  assert.ok(!invocation.args.includes('--post'));
  assert.ok(invocation.args.includes('--agent-arg=mcp_servers.lreview_vscode={command="false",enabled=false}'));
  assert.equal(invocation.env.LREVIEW_VSCODE_WORKER, '1');
  assert.equal(invocation.env.LREVIEW_EFFORT, 'medium');
  assert.equal(service.history()[0].status, 'completed');
  assert.equal(JSON.parse(await fs.readFile(path.join(result.directory, 'run.json'))).status, 'completed');
});

test('a review stays active until its final run.json is in place', async t => {
  const { service } = await setup(t);
  const run = await service.start({ commits: ['HEAD'] });
  const file = path.join(run.directory, 'run.json');
  let renaming = false, allowRename;
  const gate = new Promise(resolve => { allowRename = resolve; });
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === file) {
      renaming = true;
      await gate;
    }
    return rename(from, to);
  });

  let cancellation, shutdown;
  try {
    await until(() => renaming);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).status, 'running');
    assert.equal(service.get(run.id).status, 'running');
    cancellation = service.cancel(run.id);
    shutdown = service.dispose();
    assert.equal(service.history()[0].status, 'running');
  } finally { allowRename(); }

  const result = await cancellation;
  await shutdown;
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(result.status, 'completed');
  assert.equal(saved.status, result.status);
  assert.equal(saved.finishedAt, result.finishedAt);
});

const remotePatch = {number:64086,patchset:2,project:'fs/lustre-release',url:'https://review.whamcloud.com/64086/2',subject:'LU-99: remote patch'};

test('Gerrit workers override implicit posting while preserving the other lreview defaults', async t => {
  const { repo, service } = await setup(t, 'manual-post');
  const original = process.env.LREVIEW_CONFIG;
  t.after(() => { if (original === undefined) delete process.env.LREVIEW_CONFIG; else process.env.LREVIEW_CONFIG = original; });
  process.env.LREVIEW_CONFIG = 'my settings.toml'; // lreview resolves it from the worker cwd.
  const file = path.join(repo.directory, process.env.LREVIEW_CONFIG);
  for (const post of ['post = true\n[run]', '[run]\n"post" = true']) {
    const source = `prefix = "Rêview 🚀"\nlens_model = "opus"\n${post}\nlenses = true\nlens-effort = "high"\nstall-timeout = 47\nagent-arg = ["post = true", "kept"]\n`;
    await fs.writeFile(file, source);
    const run = await service.start({ gerritPatches: [remotePatch] });
    await until(() => service.get(run.id).status !== 'running');
    assert.equal(service.get(run.id).status, 'completed', service.get(run.id).error);
    const worker = JSON.parse(await fs.readFile(path.join(repo.directory, 'worker-config.json')));
    assert.match(worker.text, /"run" = \{ [^\n]*"post" = false/);
    assert.match(worker.text, /"prefix" = "Rêview 🚀"/);
    assert.doesNotMatch(worker.text, /lens/, 'lens options require a fresh opt-in');
    assert.match(worker.text, /"stall-timeout" = 47/);
    assert.match(worker.text, /"agent-arg" = \["post = true", "kept"\]/);
    assert.equal(worker.mode, 0o600);
    assert.equal(await fs.readFile(file, 'utf8'), source);
    await assert.rejects(fs.access(worker.config), { code: 'ENOENT' });
  }
});

test('review start rechecks the project before spawning any reviewer', async t => {
  const {repo,service}=await setup(t);
  repo.git('remote','set-url','origin','ssh://user@review.whamcloud.com:29418/ex/lustre-release');
  await assert.rejects(service.start({commits:['HEAD'],gerritPatches:[remotePatch]}),/belongs to "fs\/lustre-release".*"ex\/lustre-release"/);
  assert.equal(service.runs.size,0);
  await assert.rejects(fs.access(path.join(repo.directory,'invocation.json')), {code:'ENOENT'});
  repo.git('remote','remove','origin');
  const run=await service.start({commits:['HEAD']});
  await until(()=>service.get(run.id).status==='completed');
});

test('one launch reviews local and pinned Gerrit inputs, preserving separate reports, usage and the working copy', async t => {
  const {repo,first,second,service} = await setup(t);
  await fs.writeFile(path.join(repo.directory,'file.c'),'uncommitted edits\n');
  const head=repo.git('rev-parse','HEAD'),branch=repo.git('symbolic-ref','HEAD');
  const run=await service.start({commits:[second],gerritPatches:[remotePatch]});
  await until(()=>service.get(run.id).status==='completed');
  const saved=service.get(run.id);
  assert.deepEqual(saved.commits,[second,'gerrit:64086:2']);
  assert.equal(saved.results.length,2);
  assert.equal(saved.results[1].sha,first);
  assert.equal(saved.results[1].target,'gerrit:64086:2');
  const commands=(await fs.readFile(path.join(repo.directory,'invocations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(commands.length,2);
  assert.ok(commands[0].includes('--local')); assert.ok(!commands[1].includes('--local'));
  assert.equal(commands[1].at(-1),'https://review.whamcloud.com/c/fs/lustre-release/+/64086/2');
  assert.ok(commands.every(args=>!args.includes('--post')));
  assert.equal((await service.finding(run.id,1,0)).content,'old\n');
  const remote=reports(saved)[1];
  assert.equal(remote.status,'completed');assert.equal(remote.subjects[0].subject,remotePatch.subject);
  assert.equal(summarize(remote).findings.defect,1);
  assert.equal(saved.usage.byCommit['gerrit:64086:2'].tokens,1000);
  assert.equal(saved.usage.completed,2);
  assert.equal((await service.reportFiles(run.id,remote.reportSha)).length,1);
  assert.equal(repo.git('rev-parse','HEAD'),head);assert.equal(repo.git('symbolic-ref','HEAD'),branch);
  assert.equal(await fs.readFile(path.join(repo.directory,'file.c'),'utf8'),'uncommitted edits\n');
  await service.pendingWrites;
  const restored=new ReviewService({storage:service.storage,settings:service.settings,discoverModels:service.discoverModels});
  await restored.initialize();restored.setRepositories([repo.directory]);
  assert.equal(restored.get(run.id).results[1].target,'gerrit:64086:2');
  assert.equal((await restored.reportFiles(run.id,'gerrit:64086:2')).length,1);
});

test('Gerrit-only reviews do not implicitly include HEAD and an old patchset is pinned', async t => {
  const {repo,service} = await setup(t);
  const run=await service.start({commits:[],gerritPatches:[remotePatch]});
  await until(()=>service.get(run.id).status==='completed');
  assert.deepEqual(service.get(run.id).commits,['gerrit:64086:2']);
  const args=JSON.parse(await fs.readFile(path.join(repo.directory,'invocation.json'))).args;
  assert.ok(!args.includes('--local'));assert.ok(!args.includes('HEAD'));
  assert.equal(service.get(run.id).usage.tokens,1000);
});

test('a Gerrit resolution failure preserves earlier local results and cancellation skips the remaining batch', async t => {
  const failed=await setup(t,'gerrit-fail');
  const run=await failed.service.start({commits:[failed.second],gerritPatches:[remotePatch]});
  await until(()=>failed.service.get(run.id).status==='failed');
  const result=failed.service.get(run.id);
  assert.equal(result.results[0].status,'findings');
  assert.equal(result.results[1].status,'failed');
  assert.equal(reports(result)[0].status,'completed');
  const unlaunchable=await setup(t);
  const spawn=unlaunchable.service.spawnProcess;let launches=0;
  unlaunchable.service.spawnProcess=(...args)=>{ if (++launches===2) throw new Error('CLI could not start'); return spawn(...args); };
  const partial=await unlaunchable.service.start({commits:[unlaunchable.second],gerritPatches:[remotePatch]});
  await until(()=>unlaunchable.service.get(partial.id).status==='failed');
  assert.equal(unlaunchable.service.get(partial.id).results[0].status,'findings');
  const cancelled=await setup(t,'wait');
  const pending=await cancelled.service.start({commits:[cancelled.second],gerritPatches:[remotePatch]});
  await until(()=>cancelled.service.get(pending.id).log.includes('ready'));
  await cancelled.service.cancel(pending.id);
  await until(()=>cancelled.service.get(pending.id).status==='cancelled');
  const commands=(await fs.readFile(path.join(cancelled.repo.directory,'invocations.jsonl'),'utf8')).trim().split('\n');
  assert.equal(commands.length,1,'Gerrit batch never starts after cancellation');
});

test('cancelling during the Gerrit batch retains local results', async t => {
  const {service,second}=await setup(t,'wait-gerrit');
  const run=await service.start({commits:[second],gerritPatches:[remotePatch]});
  await until(()=>service.get(run.id).log.includes('ready'));
  await service.cancel(run.id);await until(()=>service.get(run.id).status==='cancelled');
  assert.equal(service.get(run.id).results[0].status,'findings');
  assert.equal(service.get(run.id).results[1].status,'cancelled');
});

test('clean reviews are distinct from missing artifacts', async t => {
  for (const scenario of ['clean', 'missing']) await t.test(scenario, async t => {
    const { service } = await setup(t, scenario);
    const run = await service.start({ commits: ['HEAD'] });
    await until(() => !['running', 'cancelling'].includes(service.get(run.id).status));
    const result = service.get(run.id);
    assert.equal(result.status, scenario === 'clean' ? 'completed' : 'failed');
    if (scenario === 'clean') assert.deepEqual(result.results[0].comments, []);
    else assert.ok(result.error);
  });
});

test('cancellation signals lreview, retains state, and rejects concurrent batches', async t => {
  const { service } = await setup(t, 'wait');
  const run = await service.start({});
  await until(() => service.get(run.id).log.includes('ready'));
  await assert.rejects(service.start({}), /already running/);
  await service.cancel(run.id);
  await until(() => service.get(run.id).status === 'cancelled');
  assert.match(service.get(run.id).log, /cancelled worker/);
});

test('failure results include the actual agent diagnostic, also after reload', async t => {
  const { service, repo } = await setup(t, 'runtime-error');
  const run = await service.start({ commits: ['HEAD'] });
  await until(() => service.get(run.id).status === 'failed');
  assert.equal(service.get(run.id).results[0].diagnostic, 'Cannot review: codex-code-mode-host is missing.');
  await service.pendingWrites;
  // Old versions saved only the generic failure. Enrich from the retained log.
  const saved = service.get(run.id);
  delete saved.results[0].diagnostic;
  await fs.writeFile(path.join(saved.directory, 'run.json'), JSON.stringify(saved));
  const reloaded = new ReviewService({ storage: service.storage, settings: service.settings, discoverModels: service.discoverModels });
  await reloaded.initialize();
  reloaded.setRepositories([repo.directory]);
  assert.equal(reloaded.get(run.id).results[0].diagnostic, 'Cannot review: codex-code-mode-host is missing.');
});

test('reloading an Auggie review recovers worker usage alongside previously saved charges', async t => {
  const root = await temporary(t), id = '11111111-1111-4111-8111-111111111111', sha = 'a'.repeat(40);
  const other = 'b'.repeat(40);
  const directory = path.join(root, id), artifacts = path.join(directory, 'artifacts');
  const service = new ReviewService({ storage: root });
  service.setRepositories([root]);
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(directory, 'run.json'), JSON.stringify({
    id, repository: service.repositories[0].id, agent: 'auggie', status: 'completed', commits: [sha, other],
    usage: { tokens: null, costUsd: 0.75, byCommit: { [other]: { costUsd: 0.75 } } },
  }));
  await fs.writeFile(path.join(artifacts, 'summary.json'), JSON.stringify({ one: { local: true, sha, log: 'one.log' } }));
  await fs.writeFile(path.join(artifacts, 'one.log'), [
    { type: 'message_end', message: { role: 'assistant', requestId: 'r1', usage: { totalTokens: 17 } } },
    { type: 'billing', usage_unit: 'credits', total_cost: 42 },
  ].map(event => JSON.stringify(event) + '\n').join(''));
  await service.initialize();
  const { usage } = service.get(id);
  assert.equal(usage.tokens, 17);
  assert.equal(usage.tokensPartial, true);
  assert.equal(usage.credits, 42);
  assert.equal(usage.costUsd, 0.75);
  assert.equal(usage.byCommit[sha].tokens, 17);
  assert.equal(usage.byCommit[sha].credits, 42);
  assert.equal(usage.byCommit[other].costUsd, 0.75);
});

test('invalid refs/models/efforts and closed repositories never spawn reviewers', async t => {
  const { service, repo } = await setup(t);
  await assert.rejects(service.start({ repository: '/tmp/not-open' }), /open workspace/);
  await assert.rejects(service.start({ commits: ['--bad-option'] }), /commit SHA/);
  await assert.rejects(service.start({ model: 'invented-model' }), /catalog/);
  await assert.rejects(service.start({ effort: 'unsupported' }), /reasoning effort/);
  await assert.rejects(service.start({ agent: '../other' }), /Review agent/);
  await assert.rejects(service.start({ lenses: true }), /requires Claude and Full/);
  await assert.rejects(service.start({ lenses: 'yes' }), /true or false/);
  assert.equal(service.history().length, 0);
  await assert.rejects(fs.stat(path.join(repo.directory, 'invocation.json')));
});

test('Claude backend has an independent catalog, binary, arguments, and saved agent', async t => {
  const { service, repo } = await setup(t);
  const originalSettings = service.settings;
  service.settings = async agent => {
    assert.equal(agent, 'claude');
    const { codex, ...settings } = await originalSettings();
    return { ...settings, claude: process.execPath };
  };
  const requested = [];
  service.discoverModels = async agent => {
    requested.push(agent);
    if (agent === 'codex') throw new Error('Codex is not installed');
    return [{id:'opus',name:'Opus',efforts:['max'],isDefault:true}];
  };
  await assert.rejects(service.models(false, 'codex'), /not installed/);
  await service.models(false, 'claude');
  await assert.rejects(service.start({agent:'claude',model:'codex-model'}), /catalog/);
  await assert.rejects(service.start({agent:'claude',mode:'light',lenses:true}), /requires Claude and Full/);
  const run = await service.start({agent:'claude',effort:'max',lenses:true,gerritPatches:[remotePatch],commits:['HEAD']});
  await until(() => service.get(run.id).status === 'completed');
  assert.deepEqual(requested, ['codex', 'claude']);
  assert.equal(service.get(run.id).agent, 'claude');
  assert.equal(service.get(run.id).model, 'opus');
  assert.equal(service.get(run.id).lenses, true);
  const commands = (await fs.readFile(path.join(repo.directory,'invocations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(commands.length, 2);
  assert.ok(commands.every(args => args.includes('--lenses')));
  const invocation = JSON.parse(await fs.readFile(path.join(repo.directory, 'invocation.json')));
  assert.equal(invocation.args[invocation.args.indexOf('--agent')+1], 'claude');
  assert.ok(invocation.args.includes('--agent-arg=--disallowedTools=mcp__lreview_vscode__*'));
  assert.ok(!invocation.args.some(a => a.includes('mcp_servers.')));
  const launcher = await fs.readFile(path.join(run.directory, 'bin', 'claude'), 'utf8');
  assert.match(launcher, /exec /);
});

test('artifact traversal and symlinks outside the review directory are rejected', async t => {
  const { repo } = await setup(t);
  const root = path.join(repo.directory, 'artifacts');
  await fs.mkdir(root);
  await fs.writeFile(path.join(repo.directory, 'outside.json'), '{}');
  await fs.symlink(path.join(repo.directory, 'outside.json'), path.join(root, 'link.json'));
  await assert.rejects(artifact(root, '../outside.json'), /escapes/);
  await assert.rejects(artifact(root, 'link.json'), /escapes/);
});

test('report availability requires a real file and preserves completed reports from cancelled batches', async t => {
  const { repo, first, second, service } = await setup(t);
  const id = '55555555-5555-4555-8555-555555555555';
  service.runs.set(id, {id,repository:service.repositories[0].id,commits:[first,second],status:'cancelled'});
  assert.deepEqual(await service.reportFiles(id), [], 'cancellation without artifacts has no report');
  const directory = path.join(service.storage, id, 'artifacts');
  await fs.mkdir(directory, {recursive:true});
  const summary = {first:{sha:first,local:true,markdown:'first.md'},second:{sha:second,local:true,markdown:'second.md'}};
  await fs.writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary));
  await fs.writeFile(path.join(directory, 'first.md'), '# Completed patch');
  await fs.mkdir(path.join(directory, 'second.md'));
  assert.deepEqual(await service.reportFiles(id, first), [await fs.realpath(path.join(directory, 'first.md'))]);
  assert.deepEqual(await service.reportFiles(id, second), [], 'a directory is not an openable report');
  await fs.rmdir(path.join(directory, 'second.md'));
  await fs.writeFile(path.join(repo.directory, 'outside.md'), '# Outside');
  await fs.symlink(path.join(repo.directory, 'outside.md'), path.join(directory, 'second.md'));
  await assert.rejects(service.reportFiles(id, second), /escapes/);
  await fs.unlink(path.join(directory, 'first.md'));
  assert.deepEqual(await service.reportFiles(id, first), [], 'removed reports are unavailable');
});

test('a re-review after fixing findings looks only at what changed since the reviewed commit', async t => {
  const { repo, first, second, service } = await setup(t, 'clean');
  await assert.rejects(service.start({ commits: [first, second], since: first }), /since needs exactly one local commit/);
  await assert.rejects(service.start({ commits: [second], since: second }), /Nothing changed since/);
  await assert.rejects(service.start({ commits: [second], since: 'no-such-ref' }));
  await fs.writeFile(path.join(repo.directory, 'file.c'), 'fixed\n');
  repo.git('commit', '-q', '--amend', '-am', 'LU-2: new, fixed');
  const fixed = repo.git('rev-parse', 'HEAD');
  const run = await service.start({ commits: [fixed], since: second });
  await until(() => service.get(run.id).status === 'completed');
  assert.equal(service.get(run.id).since, second, 'the run remembers what it was compared with');
  const { args } = JSON.parse(await fs.readFile(path.join(repo.directory, 'invocation.json'), 'utf8'));
  assert.deepEqual(args.slice(args.indexOf('--since'), args.indexOf('--since') + 2), ['--since', second]);
  assert.equal(args.at(-1), fixed, 'the commit stays the last argument');
});

test('discarding deletes a whole run with its directory, or some reviews of a batch with their own files', async t => {
  const {second,service} = await setup(t);
  const run = await service.start({commits:[second],gerritPatches:[remotePatch]});
  await until(()=>service.get(run.id).status==='completed');
  await service.pendingWrites;
  const directory = path.join(service.storage, run.id), artifacts = path.join(directory, 'artifacts');
  assert.ok((await fs.readdir(artifacts)).some(name => name.includes('64086_ps2')));
  assert.equal(await service.discard(run.id, ['gerrit:64086:2']), true);
  const kept = service.get(run.id);
  assert.deepEqual([kept.commits, kept.results.length, kept.gerritPatches.length], [[second], 1, 0]);
  const files = await fs.readdir(artifacts);
  assert.ok(!files.some(name => name.includes('64086_ps2')), 'the dropped review takes its files with it');
  assert.ok(files.some(name => name.startsWith(second)), 'the other review keeps its files');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'run.json'), 'utf8')).commits, [second]);
  assert.equal(await service.discard(run.id, ['unknown']), false);
  assert.equal(await service.discard(run.id, [second]), true);
  assert.equal(service.runs.has(run.id), false);
  assert.equal(await fs.stat(directory).then(() => true, () => false), false, 'the last review takes the run directory with it');
});
