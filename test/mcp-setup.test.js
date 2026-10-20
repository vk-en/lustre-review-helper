'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { connectMcp, checkMcp, serverConfig, launcherScript } = require('../src/mcp-setup');
const { temporary, script } = require('./helpers');

async function fixture(t) {
  const root = await temporary(t);
  const repository = path.join(root, 'repo with spaces');
  const configDir = path.join(root, 'claude-config');
  await fs.mkdir(repository); await fs.mkdir(configDir);
  return {root,repository,configDir,options:{binary:'/fake/agent',repository,runtime:path.join(root,"MCP 'runtime' $(literal)"),
    connectionFile:path.join(root,'workspace storage','connection.json'),command:'/Code Helper (Plugin)',
    env:{...process.env,CLAUDE_CONFIG_DIR:configDir},home:path.join(root,'home')}};
}

test('MCP setup uses native scoped argv, preserves literal paths and never invokes a shell', async t => {
  const {root,options} = await fixture(t);
  const record = path.join(root,'argv.json');
  const binary = await script(root,'client with spaces', `require('fs').writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));`);
  for (const agent of ['codex','claude','auggie']) {
    await connectMcp({...options,binary,agent});
    const {args,cwd} = JSON.parse(await fs.readFile(record,'utf8'));
    assert.equal(cwd,await fs.realpath(options.repository));
    const server=serverConfig(options.runtime,options.connectionFile,options.command,{agent,home:options.home});
    if (agent==='codex') assert.deepEqual(args,['mcp','add','lreview_vscode','--env','ELECTRON_RUN_AS_NODE=1','--',server.command,...server.args]);
    else {
      assert.deepEqual(args.slice(0,-1), agent==='claude' ? ['mcp','add-json','--scope','local','lreview_vscode'] : ['mcp','add-json','--local','--replace','lreview_vscode']);
      assert.deepEqual(JSON.parse(args.at(-1)),server);
    }
    if (agent==='auggie') {
      // Auggie's shell splits paths at spaces: its entry is a launcher whose path has none.
      assert.deepEqual(server.args,[]);
      assert.match(server.command,/^[\w./-]+\.sh$/);
      assert.ok(server.command.startsWith(path.join(options.home,'.augment','lustre-review')+path.sep));
      assert.equal((await fs.stat(server.command)).mode & 0o777,0o700);
      assert.equal(await fs.readFile(server.command,'utf8'),launcherScript(options.runtime,options.connectionFile,options.command));
    }
  }
});

test('the Auggie launcher starts the server with literal paths and the VS Code runtime flag', async t => {
  const {root,options}=await fixture(t);
  const record=path.join(root,'launched.json');
  const command=await script(root,'Code Helper (Plugin)',`require('fs').writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),flag:process.env.ELECTRON_RUN_AS_NODE}));`);
  await connectMcp({...options,command,agent:'auggie',run:async()=>({code:0})});
  const server=serverConfig(options.runtime,options.connectionFile,command,{agent:'auggie',home:options.home});
  execFileSync(server.command,{env:{PATH:process.env.PATH}});
  const launched=JSON.parse(await fs.readFile(record,'utf8'));
  assert.deepEqual(launched.args,[path.join(options.runtime,'mcp.js'),'--connection',options.connectionFile],'quotes, spaces and $( ) reach the server unchanged');
  assert.equal(launched.flag,'1');
  // A home folder with spaces cannot hold a launcher Auggie can start: the paths are quoted for its shell instead.
  const spaced=serverConfig(options.runtime,options.connectionFile,command,{agent:'auggie',home:path.join(root,'my home')});
  assert.equal(spaced.command,`'${command}'`);
  assert.deepEqual(spaced.args.slice(1),['--connection',`'${options.connectionFile}'`]);
});

test('Claude reconnect is idempotent, updates only its local entry, and rolls back failed replacements', async t => {
  const {repository,configDir,options} = await fixture(t);
  const file=path.join(configDir,'.claude.json'), realRepo=await fs.realpath(repository);
  const old={type:'stdio',command:'/old/node',args:['old-mcp.js'],env:{EXTRA:'keep for rollback'}};
  const config={otherSetting:42,projects:{[realRepo]:{mcpServers:{lreview_vscode:old,unrelated:{command:'unrelated'}}},'/other/repo':{mcpServers:{other:{command:'other'}}}}};
  await fs.writeFile(file,JSON.stringify(config));
  const calls=[];
  let failNextAdd=false;
  const run=async (_binary,args) => {
    calls.push(args);
    const data=JSON.parse(await fs.readFile(file,'utf8'));
    if (args[1]==='remove') delete data.projects[realRepo].mcpServers.lreview_vscode;
    else {
      if (failNextAdd) {failNextAdd=false;return {code:1};}
      data.projects[realRepo].mcpServers.lreview_vscode=JSON.parse(args.at(-1));
    }
    await fs.writeFile(file,JSON.stringify(data));return {code:0};
  };
  failNextAdd=true;
  await assert.rejects(connectMcp({...options,agent:'claude',run}), /could not configure/);
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),config,'failed add restores the prior server without changing other settings');
  calls.length=0;
  await connectMcp({...options,agent:'claude',run});
  assert.equal(calls.length,2);
  const updated=JSON.parse(await fs.readFile(file,'utf8'));
  assert.deepEqual(updated.projects[realRepo].mcpServers.lreview_vscode,serverConfig(options.runtime,options.connectionFile,options.command));
  assert.deepEqual(updated.projects['/other/repo'],config.projects['/other/repo']);
  assert.deepEqual(updated.projects[realRepo].mcpServers.unrelated,config.projects[realRepo].mcpServers.unrelated);
  calls.length=0;
  await connectMcp({...options,agent:'claude',run});
  assert.equal(calls.length,0,'matching entry requires no config write');
  await fs.writeFile(file,'invalid JSON');
  await assert.rejects(connectMcp({...options,agent:'claude',run}), /No settings were changed/);
  assert.equal(calls.length,0);
});

test('MCP setup errors do not expose CLI credentials or report success on failure', async t => {
  const {root,options} = await fixture(t);
  const binary=await script(root,'failed-cli',`console.error('private-token should not escape');process.exit(1);`);
  for (const agent of ['codex','claude','auggie']) await assert.rejects(connectMcp({...options,agent,binary}), error => {
    assert.match(error.message,/could not configure/);assert.doesNotMatch(error.message,/private-token/);return true;
  });
  await assert.rejects(connectMcp({...options,agent:'unknown'}),/Unknown agent/);
});

test('MCP configuration is rediscovered from native settings and distinguishes other windows or disabled entries', async t => {
  const {repository,configDir,options}=await fixture(t);
  let codex={name:'lreview_vscode',enabled:true,transport:serverConfig(options.runtime,options.connectionFile,options.command)};
  const read=async (_binary,args)=>{
    assert.deepEqual(args,['mcp','get','--json','lreview_vscode']);
    return {code:0,stdout:JSON.stringify(codex)};
  };
  const paths={claude:path.join(configDir,'.claude.json'),auggie:path.join(repository,'.augment','settings.local.json')};
  await fs.mkdir(path.dirname(paths.auggie));
  const save=async(agent,value)=>fs.writeFile(paths[agent],JSON.stringify(agent==='claude'?
    {projects:{[await fs.realpath(repository)]:{mcpServers:{lreview_vscode:value}}}}:{mcpServers:{lreview_vscode:value}}));
  for(const agent of ['codex','claude','auggie']){
    const server=serverConfig(options.runtime,options.connectionFile,options.command,{agent,home:options.home});
    if(agent==='auggie')await connectMcp({...options,agent,run:async()=>({code:0})});
    if(agent!=='codex')await save(agent,server);
    const check=()=>checkMcp({...options,agent,read});
    assert.equal((await check()).status,'configured');
    assert.equal((await check()).configured,true,'fresh checks do not rely on an in-memory click flag');
    const before=agent==='codex'?JSON.stringify(codex):await fs.readFile(paths[agent],'utf8');
    await check();
    assert.equal(agent==='codex'?JSON.stringify(codex):await fs.readFile(paths[agent],'utf8'),before,'checking never rewrites configuration');
    const other=agent==='auggie'?{...server,command:path.join(options.home,'.augment','lustre-review','mcp-000000000000.sh')}:
      {...server,args:[server.args[0],'--connection','/other/window/connection.json']};
    if(agent==='codex')codex={...codex,transport:other};else await save(agent,other);
    assert.equal((await check()).status,'otherWorkspace');
    const outdated={...server,command:'/old/code/helper'};
    if(agent==='codex')codex={...codex,transport:outdated};else await save(agent,outdated);
    assert.equal((await check()).status,'outdated');
    if(agent==='codex')codex={...codex,transport:server,enabled:false};else await save(agent,{...server,disabled:true});
    assert.equal((await check()).status,'disabled');
    codex={...codex,enabled:true,transport:server};
    if(agent==='auggie'){
      // An entry from before the launcher cannot start: Auggie splits its paths.
      await save(agent,serverConfig(options.runtime,options.connectionFile,options.command));
      const old=await check();
      assert.equal(old.status,'outdated');assert.match(old.message,/paths have spaces/);
      await save(agent,server);
      await fs.writeFile(server.command,'#!/bin/sh\nexit 1\n');
      assert.equal((await check()).status,'outdated','a changed launcher needs a reconnect');
    }
  }
});

test('missing, corrupt, failing and aborted MCP checks remain explicit and do not expose diagnostics', async t => {
  const {root,configDir,options}=await fixture(t);
  for(const agent of ['claude','auggie'])assert.equal((await checkMcp({...options,agent})).status,'missing');
  assert.equal((await checkMcp({...options,agent:'codex',read:async()=>({code:1,stderr:'No MCP server named lreview_vscode found'})})).status,'missing');
  for(const response of [{code:1,stderr:'private-token'},{code:0,stdout:'private-token'},{code:0,stdout:'{}'}]){
    const result=await checkMcp({...options,agent:'codex',read:async()=>response});
    assert.equal(result.status,'unknown');assert.equal(result.configured,false);assert.doesNotMatch(result.message,/private-token/);
  }
  await fs.writeFile(path.join(configDir,'.claude.json'),'invalid JSON');
  assert.equal((await checkMcp({...options,agent:'claude'})).status,'unknown');
  const binary=await script(root,'stall',`setInterval(()=>{},1000);`),controller=new AbortController();
  const pending=checkMcp({...options,agent:'codex',binary,signal:controller.signal});controller.abort();
  assert.equal((await pending).status,'unknown');
});
