'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { repository, script, until } = require('./helpers');

test('extension activation wires accordion, commit selection, settings, and MCP configuration', async t => {
  const repo = await repository(t);
  repo.git('remote','add','origin','https://review.whamcloud.com/fs/lustre-release');
  await repo.commit('code\n', 'LU-1: first');
  const gerritConfig = path.join(repo.directory, 'gerrit-config', '.env');
  const oldConfig = process.env.GERRIT_CLI_ENV_FILE, oldHome = process.env.HOME;
  process.env.GERRIT_CLI_ENV_FILE = gerritConfig;
  // The MCP setup writes launchers under the home folder; keep them in the test's.
  process.env.HOME = path.join(repo.directory, 'home');
  t.after(() => {
    if (oldConfig === undefined) delete process.env.GERRIT_CLI_ENV_FILE; else process.env.GERRIT_CLI_ENV_FILE = oldConfig;
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  });
  await script(repo.directory, 'gerrit', `
    if(process.argv[2]==='--version'){console.log('gerrit 0.2.24');process.exit(0);}
    if(process.argv[2]==='diff') {
      if(process.argv.slice(3).join(' ')!=='https://review.whamcloud.com/64086 2 3'||process.env.GERRIT_URL!=='https://review.whamcloud.com')process.exit(4);
      console.log(JSON.stringify({files:[{path:'file.c',status:'M'}]}));process.exit(0);
    }
    if(process.argv[2]==='info'&&require('fs').existsSync(require('path').join(__dirname,'newer-patchset'))) {
      console.log(JSON.stringify({change_number:64086,project:'fs/lustre-release',branch:'master',subject:'LU-12345: Gerrit patch',owner:'Gerrit Author',status:'NEW',current_patchset:3,patchsets:[{number:2},{number:3}],mergeable:false,
        jenkins_build:{status:'SUCCESS'},ci:{maloo_vote:-1},reviewers:[{name:'Other Reviewer',approvals:{'Code-Review':'+1'}}]}));process.exit(0);
    }
    if(process.argv[2]==='info') {
      if(process.argv[3]!=='https://review.whamcloud.com/64086'||process.env.GERRIT_URL!=='https://review.whamcloud.com')process.exit(4);
      console.log(JSON.stringify({change_number:64086,project:'fs/lustre-release',branch:'master',subject:'LU-12345: Gerrit patch',owner:'Gerrit Author',current_patchset:2,patchsets:[{number:2}]}));process.exit(0);
    }
    if(process.argv[2]==='comments'&&process.argv.includes('--timeline')) {
      if(![64086,64087].map(n=>'https://review.whamcloud.com/'+n+' --all --no-context --timeline').includes(process.argv.slice(3).join(' '))||process.env.GERRIT_URL!=='https://review.whamcloud.com')process.exit(4);
      if(process.argv[3].endsWith('64086'))console.log(JSON.stringify({timeline:[{author:'Chris Horn',patch_set:2,updated:'2026-10-17 18:30:58.000000000',message:'**[AI review - opus]**\\n\\nLooks fine.'},
        {author:'Chris Horn',patch_set:1,updated:'2026-10-16 18:30:58.000000000',message:'**[AI review - opus]** older'},{author:'Other Reviewer',patch_set:2,updated:'2026-10-17 19:00:00.000000000',message:'[nit] typo'}]}));
      else console.log(JSON.stringify({timeline:[{author:'Gerrit Author',updated:'2026-10-18 09:00:00.000000000',message:'Fixed, thanks.'}]}));process.exit(0);
    }
    if(process.argv[2]==='comments') {
      if(process.argv.slice(3).join(' ')!=='https://review.whamcloud.com/64086 --no-context'||process.env.GERRIT_URL!=='https://review.whamcloud.com')process.exit(4);
      const comment=(patch_set,message)=>({patch_set,file_path:'file.c',line:1,message,author:{name:'Other Reviewer'},unresolved:true,updated:'2026-10-16 10:00:00.000000000'});
      console.log(JSON.stringify({threads:[{root_comment:comment(2,'Please explain this line.'),replies:[]},{root_comment:comment(1,'From patchset 1.'),replies:[]}]}));process.exit(0);
    }
    if(process.argv.slice(2).join(' ')!=='check')process.exit(9);
    const fs=require('fs'),path=require('path');fs.appendFileSync(path.join(__dirname,'gerrit-checks'),'check\\n');
    console.log(JSON.stringify({status:'connected',message:'Authentication verified.',authenticated:true,config_file:process.env.GERRIT_CLI_ENV_FILE}));
  `);
  await script(repo.directory, 'gerrit-dashboard', `
    const fs=require('fs'),path=require('path'),args=process.argv.slice(2);
    if(args.join(' ')!=='refresh --projects fs/lustre-release'||process.env.GERRIT_URL!=='https://review.whamcloud.com'||!process.env.GD_DATA_DIR)process.exit(9);
    const record=(number,extra)=>({number,subject:'LU-'+number+' llite: change',project:'fs/lustre-release',branch:'master',status:'NEW',wip:false,ps:2,
      ps_created:'2026-10-16 10:00:00.000000000',updated:'2026-10-18 09:00:00.000000000',owner:'Gerrit Author',owner_id:7,
      ps_history:[{ps:1,date:'2026-10-10 10:00:00.000000000'},{ps:2,date:'2026-10-16 10:00:00.000000000'}],
      build:{state:'SUCCESS'},test:{state:'PASS'},gate:'OK',review:{humans:[],my_vote:0,prior_vote:null,neg:false},activity:{me:''},...extra});
    const dir=path.join(process.env.GD_DATA_DIR,'users','tester');fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'snapshot.json'),JSON.stringify({schema:22,self:{account_id:1,name:'Tester'},projects:['fs/lustre-release'],
      reviews:{requested:[record(64086,{})],re_review:[record(64087,{activity:{me:'2026-10-17 10:00:00.000000000'}})]}}));
    console.log('snapshot written');
  `);
  const commands = new Map(), providers = new Map(), saved = new Map(), messages = [], shown = [], errors = [];
  let outputText = '', outputShown = false, focused, pickIndex = 0, failReport;
  saved.set('model', { id: 'gpt-test', name: 'Legacy Codex model', efforts: ['medium'] });
  saved.set('effort', 'medium');
  const claudeExtension = path.join(repo.directory, 'claude-extension');
  const claudeDirectory = path.join(claudeExtension, 'resources', 'native-binary');
  await fs.mkdir(claudeDirectory, { recursive: true });
  await script(claudeDirectory, 'claude', `
    if(process.argv[2]==='--version') { console.log('2.1.301 (Claude Code)'); process.exit(0); }
    if(process.argv[2]==='mcp') { console.log('Added stdio MCP server'); process.exit(0); }
    if(process.argv[2]==='auth') { console.log(JSON.stringify({loggedIn:true})); process.exit(0); }
    require('readline').createInterface({input:process.stdin}).on('line', line => {
      const m=JSON.parse(line);
      const response=m.request.subtype==='get_usage'?{rate_limits:{five_hour:{utilization:10,resets_at:'2099-01-01T00:00:00Z'}}}:{models:[
        {value:'opus',displayName:'Opus',supportedEffortLevels:['high','max']},
        {value:'sonnet',displayName:'Sonnet',supportedEffortLevels:['high']}
      ]};
      console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response}}));
    });
  `);
  const codex = await script(repo.directory, 'codex', `
    if(process.argv[2]==='--version') { console.log('codex-cli 0.162.0'); process.exit(0); }
    if(process.argv[2]==='mcp') {
      const fs=require('fs'),path=require('path'),file=path.join(__dirname,'codex-mcp.json'),args=process.argv.slice(2);
      if(args[1]==='get') {
        if(!fs.existsSync(file)){console.error('No MCP server named lreview_vscode found');process.exit(1);}
        console.log(fs.readFileSync(file,'utf8'));process.exit(0);
      }
      fs.writeFileSync(path.join(__dirname,'mcp-argv.json'),JSON.stringify(args));
      const command=args.indexOf('--')+1;
      fs.writeFileSync(file,JSON.stringify({name:'lreview_vscode',enabled:true,transport:{type:'stdio',command:args[command],args:args.slice(command+1),env:{ELECTRON_RUN_AS_NODE:'1'}}}));process.exit(0);
    }
    if(process.argv[2]==='login') { console.log('Logged in'); process.exit(0); }
    require('readline').createInterface({input:process.stdin}).on('line', line => {
      const m=JSON.parse(line);
      if(m.method==='initialized') return;
      const result=m.method==='account/rateLimits/read'?{rateLimits:{secondary:{usedPercent:59,windowDurationMins:10080,resetsAt:4070908800}}}:{};
      console.log(JSON.stringify({id:m.id,result}));
    });
  `);
  const auggie = await script(repo.directory, 'auggie', `
    if(process.argv[2]==='mcp'){
      const fs=require('fs'),path=require('path'),dir=path.join(process.cwd(),'.augment');fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(path.join(dir,'settings.local.json'),JSON.stringify({mcpServers:{lreview_vscode:JSON.parse(process.argv.at(-1))}}));process.exit(0);
    }
    console.log(process.argv[2]==='--version'?'0.36.0 (commit abc)':'{}');
  `);
  const lreview = await script(repo.directory, 'lreview', `
    if(process.argv.includes('--version')) { console.log('lreview 0.2.7'); process.exit(0); }
    const fs=require('fs'),path=require('path'),args=process.argv.slice(2);
    const dest=args[args.indexOf('--results-dir')+1];
    const summaryFile=path.join(dest,'summary.json'),summary=fs.existsSync(summaryFile)?JSON.parse(fs.readFileSync(summaryFile,'utf8')):{};
    if(args[0]==='post') {
      if(args.includes('--force')||!summary[args[1]])process.exit(4);
      fs.appendFileSync(path.join(__dirname,'published.jsonl'),JSON.stringify(args)+'\\n');
      summary[args[1]].posted=true;
      fs.writeFileSync(summaryFile,JSON.stringify(summary));process.exit(0);
    }
    if (fs.existsSync(path.join(__dirname,'cancel-next'))) {
      console.log('run started');
      process.on('SIGINT',()=>process.exit(143));
      setInterval(()=>{},1000);
      return;
    }
    fs.mkdirSync(path.join(dest,'markdown'),{recursive:true});
    for(const sha of args.filter(a=>/^[a-f0-9]{40}$/.test(a))) {
      const markdown='markdown/'+sha+' Report.md';
      fs.writeFileSync(path.join(dest,markdown),'# Review completed');
      summary[sha]={sha,local:true,status:'clean',markdown,tokens:2500,cost_usd:0.1234};
    }
    for(const url of args.filter(a=>a.startsWith('https://review.whamcloud.com/'))) {
      if(url!=='https://review.whamcloud.com/c/fs/lustre-release/+/64086/2'||args.includes('--local')||args.includes('--post'))process.exit(4);
      const sha=require('child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),markdown='markdown/64086_ps2.md';
      fs.writeFileSync(path.join(dest,markdown),'# Gerrit review completed');
      const mode=args[args.indexOf('--mode')+1];
      summary['64086'+(mode==='light'?'-light':'')]={sha,local:false,number:64086,patchset:2,repository:'fs/lustre-release',base_url:'https://review.whamcloud.com',mode,status:'clean',markdown,tokens:1500,cost_usd:0.2};
    }
    fs.writeFileSync(path.join(dest,'summary.json'),JSON.stringify(summary));
    console.log('run started');
    setTimeout(()=>console.log('run complete'),1200);
  `);
  let document, configurationListener, updateTarget, workspaceLimit;
  const noop = () => {};
  const disposable = () => ({ dispose: noop });
  const uri = file => ({ fsPath: file, scheme: 'file', toString: () => file });
  const settings = { commitLimit: 30, mode: 'full', jobs: 2, timeout: 60, lreviewPath: lreview, codexPath: codex, auggiePath: auggie };
  let branchChanged;
  const gitRepository = { rootUri: uri(repo.directory), state: {
    HEAD: { commit: repo.git('rev-parse', 'HEAD'), name: repo.git('symbolic-ref', '--short', 'HEAD') },
    onDidChange: callback => { branchChanged = callback; return disposable(); },
  } };
  const gitApi = { repositories: [gitRepository], onDidOpenRepository: disposable, onDidCloseRepository: disposable };
  const statusBar = { show: noop, dispose: noop };
  const terminals = [], external = [], executed = [], commentThreads = [];
  let terminalClosed;
  const vscode = {
    workspace: { isTrusted: true, workspaceFolders: [{ uri: uri(repo.directory) }],
      getConfiguration: () => ({ get: key => settings[key], inspect: () => ({ workspaceValue: workspaceLimit }),
        update: async (key, value, target) => {
          settings[key] = value; updateTarget = target;
          configurationListener({ affectsConfiguration: section => section === 'lustreReview' || section === `lustreReview.${key}` });
        } }),
      registerTextDocumentContentProvider: disposable, onDidCloseTextDocument: disposable,
      onDidChangeWorkspaceFolders: disposable,
      onDidChangeConfiguration: cb => { configurationListener = cb; return disposable(); },
      openTextDocument: async options => (document = options) },
    StatusBarAlignment: { Left: 1 },
    env: { openExternal: async url => external.push(url) },
    window: {
      createStatusBarItem: () => statusBar,
      onDidChangeWindowState: disposable,
      onDidCloseTerminal: cb => { terminalClosed = cb; return disposable(); },
      createTerminal: options => { const terminal = { ...options, show: noop, dispose: noop }; terminals.push(terminal); return terminal; },
      createOutputChannel: () => ({ appendLine: s => { outputText += s+'\n'; }, clear: () => { outputText=''; },
        append: s => { outputText += s; }, show: () => { outputShown=true; }, dispose: noop }),
      showErrorMessage: message => errors.push(message),
      showTextDocument: async (document, options) => {
        if (failReport && document.fsPath?.includes(failReport)) throw new Error('Editor could not open this report');
        shown.push({ document, options });
      },
      showQuickPick: async items => items[pickIndex],
      registerWebviewViewProvider: (id, provider) => { providers.set(id, provider); return disposable(); },
    },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return disposable(); },
      executeCommand: async (id, ...args) => { focused=id; executed.push([id, ...args]); return commands.get(id)?.(...args); } },
    comments: { createCommentController: () => ({ createCommentThread: (uri, range, comments) => { const thread = { uri, range, comments, dispose() { this.disposed = true; } }; commentThreads.push(thread); return thread; }, dispose: noop }) },
    Range: class { constructor(startLine) { this.startLine = startLine; } }, MarkdownString: class { constructor(value) { this.value = value; } },
    CommentMode: { Preview: 1 }, CommentThreadCollapsibleState: { Expanded: 1 },
    extensions: { getExtension: name => name === 'vscode.git' ? { activate: async () => ({ getAPI: () => gitApi }) } :
      name === 'Anthropic.claude-code' ? { extensionPath: claudeExtension } : undefined },
    Uri: { parse: value => value, file: uri, joinPath: (root, ...parts) => uri(path.join(root.fsPath, ...parts)), from: parts => ({ ...parts }) },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
  };
  const extensionPath = path.resolve(__dirname, '..');
  const file = path.join(extensionPath, 'src/extension.js');
  const nativeRequire = createRequire(file);
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(file, 'utf8'), {
    module, require: name => name === 'vscode' ? vscode : nativeRequire(name),
    process, setTimeout, clearTimeout, setInterval, clearInterval, console, AbortController,
  }, { filename: file });
  const context = { extensionPath, extensionUri: uri(extensionPath), subscriptions: [],
    storageUri: uri(path.join(repo.directory, 'storage')), globalStorageUri: uri(path.join(repo.directory, 'global')),
    workspaceState: { get: (key, fallback) => saved.has(key) ? saved.get(key) : fallback,
      update: async (key, value) => saved.set(key, value) } };
  // Before activating: a failed activation still stops what it started.
  t.after(async () => { await module.exports.deactivate(); for (const d of context.subscriptions) d.dispose(); });
  const api = await module.exports.activate(context);
  let receive, badge, activityBadge = 1;
  // Match VS Code's WebviewView: undefined does not clear its activity.
  const reviewView = { get badge() { return badge; }, set badge(value) { badge = value; if (value) activityBadge = value.value; }, webview: {
    cspSource: 'vscode-resource:', asWebviewUri: value => value.toString(),
    postMessage: message => messages.push(message),
    onDidReceiveMessage: cb => { receive = cb; return disposable(); },
  } };
  providers.get('lustreReview.review').resolveWebviewView(reviewView);
  assert.equal(providers.size, 1);
  assert.match(reviewView.webview.html, /id="agent"/);
  assert.match(reviewView.webview.html, /id="stats"/);
  assert.doesNotMatch(reviewView.webview.html, /id="log"/);
  assert.doesNotMatch(reviewView.webview.html, /id="settings"/);
  await receive({ type: 'ready' });
  await until(() => messages.at(-1).connections.every(entry => entry.status === 'connected'));
  await until(() => messages.at(-1).mcpSetup.codex.status === 'missing');
  assert.equal(messages.at(-1).section, 'commits');
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1).commits[0].gerrit)),{state:'none',reason:'changeId'},'a commit without Change-Id has no Gerrit link');
  await receive({type:'openCommitChange',repository:messages.at(-1).repositoryId,sha:messages.at(-1).commits[0].sha});
  assert.equal(external.length,0);
  // A click on a commit opens the multi-file diff Reports & History uses.
  await receive({type:'showCommit',repository:messages.at(-1).repositoryId,sha:messages.at(-1).commits[0].sha});
  const commitDiff = executed.filter(([id]) => id === 'vscode.changes').at(-1);
  assert.equal(commitDiff[1], `Commit ${messages.at(-1).commits[0].shortSha} · ${messages.at(-1).commits[0].subject}`);
  assert.equal(commitDiff[2][0][0].path, '/COMMIT_MSG');
  assert.ok(commitDiff[2].length > 1, 'the changed files follow the commit message');
  assert.equal(messages.at(-1).branch, gitRepository.state.HEAD.name);
  repo.git('switch', '-qc', 'review/same-commit');
  gitRepository.state.HEAD.name = 'review/same-commit'; branchChanged();
  await until(() => messages.at(-1).branch === 'review/same-commit');
  await until(() => messages.at(-1).lreview.version === '0.2.7');
  await until(() => messages.at(-1).gerrit.status === 'connected');
  assert.equal(messages.at(-1).gerrit.version, '0.2.24');
  assert.equal(messages.at(-1).gerrit.configFile, gerritConfig);
  await receive({type:'ready'});
  await receive({type:'section',value:'settings'});
  assert.equal(await fs.readFile(path.join(repo.directory,'gerrit-checks'),'utf8'), 'check\n', 'opening Settings does not repeat the startup Gerrit check');
  await receive({type:'gerritCheck'});
  assert.equal(await fs.readFile(path.join(repo.directory,'gerrit-checks'),'utf8'), 'check\ncheck\n');
  // Check connection beside a Gerrit problem in Gerrit patches: Utilities, checked now.
  const tabBefore=messages.at(-1).settingsTab;
  await receive({type:'checkGerrit'});
  assert.deepEqual([messages.at(-1).section,messages.at(-1).settingsTab],['settings','utilities']);
  await until(async()=>(await fs.readFile(path.join(repo.directory,'gerrit-checks'),'utf8'))==='check\ncheck\ncheck\n');
  // The gear beside the agent and model on Review: AI Settings, Agent.
  await receive({type:'openSettings',tab:'agent'});
  assert.deepEqual([messages.at(-1).section,messages.at(-1).settingsTab],['settings','agent']);
  await receive({type:'openSettings',tab:'nowhere'});
  assert.equal(messages.at(-1).settingsTab,'agent','an unknown category changes nothing');
  // AI Settings → Language: the page is written again in the chosen language;
  // Automatic clears the setting and follows VS Code, English here.
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1).language)),{setting:'auto',vscode:'en',active:'en'});
  await receive({type:'settingsTab',value:'language'});
  assert.equal(messages.at(-1).settingsTab,'language');
  await receive({type:'language',value:'ru'});
  assert.deepEqual([settings.language,updateTarget],['ru',1]);
  assert.match(reviewView.webview.html,/<html lang="ru">/);
  assert.match(reviewView.webview.html,/>Локальные коммиты</);
  assert.match(reviewView.webview.html,/id="languageOption-ru"[^>]*>|aria-selected="true" data-language="ru"/);
  await receive({type:'ready'});
  assert.equal(messages.at(-1).language.active,'ru');
  assert.ok(['Идёт обзор','Отчёт готов','Обзор не удался','Готов к обзору'].includes(messages.at(-1).reviewStatusLabel),'the status label follows the language');
  await receive({type:'language',value:'klingon'});
  assert.equal(settings.language,'ru','an unknown language changes nothing');
  await receive({type:'language',value:'auto'});
  assert.equal(settings.language,undefined);
  assert.match(reviewView.webview.html,/<html lang="en">/);
  assert.match(reviewView.webview.html,/>Local commits</);
  await receive({type:'ready'});
  await receive({type:'settingsTab',value:tabBefore});
  await receive({type:'gerritBotName',value:' Lustre Bot '});
  assert.equal(settings.gerritBotName,'Lustre Bot');
  assert.equal(messages.at(-1).gerritBotName,'Lustre Bot');
  assert.equal(messages.at(-1).gerritSignatureDetails,false);
  await receive({type:'gerritSignatureDetails',value:true});
  assert.equal(settings.gerritSignatureDetails,true);
  assert.equal(updateTarget,vscode.ConfigurationTarget.Global);
  await receive({type:'gerritSignatureDetails',value:'false'});
  assert.equal(settings.gerritSignatureDetails,true,'only boolean checkbox values are accepted');
  await receive({type:'gerritSignatureDetails',value:false});
  assert.equal(messages.at(-1).gerritSignatureDetails,false);
  await receive({type:'gerritBotName',value:'bad\nname'});
  assert.match(errors.pop(),/single line/);
  await receive({type:'gerritConfig'});
  assert.equal(shown.at(-1).document.fsPath,gerritConfig);
  assert.equal(shown.at(-1).options.preview,false);
  assert.equal((await fs.stat(gerritConfig)).mode & 0o777,0o600);
  await fs.writeFile(gerritConfig,'GERRIT_PASS=private-test-password\n');
  await receive({type:'gerritConfig'});
  assert.equal(await fs.readFile(gerritConfig,'utf8'),'GERRIT_PASS=private-test-password\n');
  assert.ok(!JSON.stringify(messages).includes('private-test-password'),'credentials never enter webview state');
  await receive({type:'section',value:'gerritPatches'});
  assert.equal(messages.at(-1).section,'gerritPatches');
  await receive({type:'addGerritPatch',url:'https://review.whamcloud.com.evil.test/64086'});
  assert.equal(messages.at(-1).gerritPatches.error,true);
  assert.equal(messages.at(-1).gerritPatches.items.length,0);
  await receive({type:'addGerritPatch',url:'https://review.whamcloud.com/c/fs/lustre-release/+/64086'});
  assert.equal(messages.at(-1).gerritPatches.items[0].owner,'Gerrit Author');
  assert.equal(messages.at(-1).gerritPatches.items.length,1);
  await receive({type:'addGerritPatch',url:'https://review.whamcloud.com/64086'});
  assert.match(messages.at(-1).gerritPatches.message,/already in the list/);
  await receive({type:'removeGerritPatch',number:64086});
  assert.equal(messages.at(-1).gerritPatches.items.length,0);
  // Waiting Review and In progress: loaded on first look, filtered, ticked for review.
  assert.equal(messages.at(-1).patchesTab,'url');
  assert.equal(messages.at(-1).queue.project,'fs/lustre-release');
  assert.equal(messages.at(-1).queue.loaded,false,'the URL tab loads nothing');
  await receive({type:'patchesTab',value:'waiting'});
  await until(() => messages.at(-1).queue.loaded && !messages.at(-1).queue.refreshing);
  assert.equal(messages.at(-1).patchesTab,'waiting');
  assert.equal(messages.at(-1).queue.error,undefined);
  assert.deepEqual(messages.at(-1).queue.waiting.map(item => item.number),[64086]);
  assert.deepEqual(messages.at(-1).queue.waiting[0].aiOthers.map(review => [review.author,review.count]),[['Chris Horn',1]],'another AI review of the current patchset is marked');
  assert.deepEqual(messages.at(-1).queue.progress.map(item => [item.number,item.kind,item.replyAt]),[[64087,'replied','2026-10-18T09:00:00.000Z']]);
  assert.deepEqual(messages.at(-1).queueFilters,{waiting:['ciFailed','ciRunning'],progress:['mine','ciFailed','ciRunning']});
  await receive({type:'queueFilters',tab:'waiting',hidden:['bogus']});
  await receive({type:'queueFilters',tab:'elsewhere',hidden:[]});
  assert.deepEqual(messages.at(-1).queueFilters.waiting,['ciFailed','ciRunning'],'unknown filters are ignored');
  await receive({type:'queueFilters',tab:'waiting',hidden:['ready']});
  assert.deepEqual(messages.at(-1).queueFilters.waiting,['ready']);
  await receive({type:'queueSelect',number:99999,checked:true});
  assert.equal(messages.at(-1).gerritPatches.items.length,0,'only listed changes can be ticked');
  await receive({type:'queueSelect',number:64086,checked:true});
  await until(() => messages.at(-1).gerritPatches.items.length===1 && !messages.at(-1).gerritPatches.adding.length);
  assert.equal(messages.at(-1).queue.waiting[0].selected,true);
  assert.equal(messages.at(-1).gerritPatches.items[0].patchset,2);
  await receive({type:'queueSelect',number:64086,checked:false});
  assert.equal(messages.at(-1).gerritPatches.items.length,0);
  await receive({type:'openChange',number:64087});
  assert.equal(external.at(-1),'https://review.whamcloud.com/c/fs/lustre-release/+/64087');
  await receive({type:'openChange',number:12345});
  assert.equal(external.at(-1),'https://review.whamcloud.com/c/fs/lustre-release/+/64087','unknown changes are not opened');
  external.length = 0;
  await receive({type:'patchesLayout',value:'cards'});
  assert.equal(messages.at(-1).patchesLayout,'cards');
  await receive({type:'patchesLayout',value:'table'});
  assert.equal(messages.at(-1).patchesLayout,'cards');
  assert.equal(messages.at(-1).gerritDashboard.installed,true);
  await receive({type:'patchesTab',value:'url'});
  await receive({type:'section',value:'commits'});
  assert.equal(messages.at(-1).reviewStatus, 'idle');
  assert.equal(statusBar.color, '#a0a0a0');
  assert.equal(activityBadge, 0, 'stale activity is cleared when the view is restored');
  assert.equal(messages.at(-1).autoOpenReports, true);
  await receive({type:'autoOpenReports',value:false});
  await receive({type:'autoOpenReports',value:'true'});
  assert.equal(messages.at(-1).autoOpenReports, false);
  assert.equal(saved.get('autoOpenReports'), false);
  await receive({type:'agentHelp',agent:'claude'});
  assert.match(external[0], /^https:\/\/code.claude.com\//);
  await receive({type:'lreviewHelp'});
  assert.equal(external.at(-1),'https://github.com/lustre-tools/llm_code_and_review_tools');
  await receive({type:'authenticate',agent:'auggie',action:'login'});
  assert.equal(terminals[0].shellPath, auggie);
  assert.deepEqual(Array.from(terminals[0].shellArgs), ['login']);
  assert.equal(terminals[0].shellArgs.length, 1, 'no prompt or credential is passed to the terminal');
  terminalClosed(terminals[0]);
  await commands.get('lustreReview.version')();
  assert.deepEqual([executed.at(-1)[0], executed.at(-1)[1].fsPath], ['markdown.showPreview', path.join(extensionPath, 'CHANGELOG.md')], 'the version opens the changelog');
  await commands.get('lustreReview.settings')();
  assert.equal(focused, 'lustreReview.review.focus');
  assert.equal(messages.at(-1).section, 'settings');
  await receive({type:'section',value:'review'});
  assert.equal(messages.at(-1).section, 'review');
  await until(() => messages.at(-1).accountLimits.snapshot);
  assert.equal(messages.at(-1).accountLimits.snapshot.windows[0].usedPercent, 59);
  assert.equal(messages.at(-1).statsRun, undefined, 'limits are available before any review');
  assert.equal(saved.get('section'), 'review');
  await receive({type:'section',value:'invalid'});
  assert.equal(saved.get('section'), 'review');
  await receive({type:'section',value:null});
  assert.equal(messages.at(-1).section, 'review');
  assert.equal(saved.get('section'), 'review');
  assert.equal(messages.at(-1).selected, 1);
  assert.equal(messages.at(-1).mode, 'full');
  assert.equal(messages.at(-1).agent, 'codex');
  assert.equal(messages.at(-1).model.id, 'gpt-test');
  await receive({ type: 'agent', value: 'claude' });
  assert.equal(messages.at(-1).agent, 'claude');
  assert.equal(messages.at(-1).model.id, 'opus');
  assert.equal(messages.at(-1).effort, '');
  await receive({ type: 'effort', value: 'max' });
  await receive({ type: 'agent', value: 'codex' });
  assert.equal(messages.at(-1).model.id, 'gpt-test');
  assert.equal(messages.at(-1).effort, 'medium');
  await receive({ type: 'agent', value: 'claude' });
  assert.equal(messages.at(-1).model.id, 'opus');
  assert.equal(messages.at(-1).effort, 'max');
  assert.equal(saved.get('agent'), 'claude');
  const commits = messages.at(-1).commits;
  const repositoryId = messages.at(-1).repositoryId;
  assert.equal(commits[0].selected, true);
  assert.equal(messages.at(-1).selectedCommits[0].subject, 'LU-1: first');
  await receive({type:'selection',repository:repositoryId,sha:commits[0].sha,checked:false});
  assert.equal(messages.at(-1).selected, 0);
  assert.equal(messages.at(-1).selectedCommits.length, 0);
  for (const invalid of [{repository:'stale'}, {sha:'unknown'}, {checked:'true'}]) {
    await receive({type:'selection',repository:repositoryId,sha:commits[0].sha,checked:true,...invalid});
    assert.equal(messages.at(-1).selected, 0);
  }
  await commands.get('lustreReview.selectAll')();
  assert.equal(messages.at(-1).selected, 1);
  await commands.get('lustreReview.mcpConfig')();
  assert.match(document.content, /\[mcp_servers.lreview_vscode\]/);
  assert.match(document.content, /ELECTRON_RUN_AS_NODE/);
  assert.match(document.content, /mcp-runtime/);
  assert.deepEqual(messages.at(-1).connections.map(entry=>entry.version), ['0.162.0','2.1.301','0.36.0']);
  const tabsBefore=shown.length;
  await receive({type:'connectMcp',agent:'codex'});
  assert.match(messages.at(-1).mcpSetup.codex.message,/Configured/);
  assert.equal(messages.at(-1).mcpSetup.codex.configured, true);
  assert.equal(messages.at(-1).mcpSetup.codex.pending,false);
  assert.equal(shown.length,tabsBefore,'Connect configures directly without opening a config document');
  const mcpArgs=JSON.parse(await fs.readFile(path.join(repo.directory,'mcp-argv.json'),'utf8'));
  assert.deepEqual(mcpArgs.slice(0,6),['mcp','add','lreview_vscode','--env','ELECTRON_RUN_AS_NODE=1','--']);
  assert.equal(mcpArgs.at(-1),path.join(context.storageUri.fsPath,'connection.json'));
  await receive({type:'connectMcp',agent:'auggie'});
  assert.match(messages.at(-1).mcpSetup.auggie.message,/Configured/);
  await receive({type:'connectMcp',agent:'invalid'});

  await repo.commit('updated code\n', 'LU-2: second');
  await commands.get('lustreReview.refresh')();
  assert.equal(messages.at(-1).commits.length, 2);
  assert.equal(messages.at(-1).commitLimit, 30);
  await receive({type:'mode',value:'light'});
  await receive({type:'commitLimit',value:1});
  await until(() => messages.at(-1).commits.length === 1);
  assert.equal(messages.at(-1).commits[0].subject, 'LU-2: second');
  assert.equal(settings.commitLimit, 1);
  assert.equal(updateTarget, vscode.ConfigurationTarget.Global);
  assert.equal(messages.at(-1).commitLimit, 1);
  assert.equal(messages.at(-1).mode, 'light', 'changing the commit count preserves the chosen review depth');
  workspaceLimit = 1;
  await receive({type:'commitLimit',value:2});
  await until(() => messages.at(-1).commits.length === 2);
  assert.equal(updateTarget, vscode.ConfigurationTarget.Workspace);
  for (const value of [0, 201, 1.5, '10', null]) {
    await receive({type:'commitLimit',value});
    assert.equal(settings.commitLimit, 2);
  }
  assert.equal(errors.length, 5);
  assert.ok(errors.every(e => e.includes('whole number from 1 to 200')));
  errors.length = 0;
  await receive({type:'commitLimit',value:30});
  await receive({type:'selectAll'});
  assert.equal(messages.at(-1).selectedCommits.map(c => c.subject).join('|'), 'LU-2: second|LU-1: first');
  await receive({type:'refresh'});
  assert.equal(messages.at(-1).selectedCommits.length, 2, 'selection survives refresh');
  const review = await api.startReview({agent:'claude',commits:['HEAD~1','HEAD'],source:'mcp'});
  const firstReportId = `${review.id}:${review.commits[0]}`, secondReportId = `${review.id}:${review.commits[1]}`;
  await until(()=>api.getReview(review.id).log.includes('run started'));
  await receive({type:'ready'});
  await receive({type:'logs'});assert.equal(outputShown,true);assert.match(outputText,/run started/);
  assert.equal(messages.at(-1).run.log, undefined);
  await until(()=>api.getReview(review.id).usage?.sampledAt);
  const reports = () => shown.filter(item => item.document.fsPath?.endsWith('.md'));
  await until(() => api.getReview(review.id).status === 'completed' && messages.at(-1).unreadCount === 2);
  assert.match(outputText,/run complete/);
  await commands.get('lustreReview.refresh')();
  assert.equal(reports().length, 0, 'unchecked auto-open leaves reports in History');
  await receive({type:'ready'});
  assert.equal(messages.at(-1).statsRun.id, review.id);
  assert.equal(messages.at(-1).usageStatistics[0].tokens, 5000);
  assert.equal(messages.at(-1).usageStatistics[0].cost, 0.2468);
  assert.equal(messages.at(-1).reviewStatus, 'completed');
  assert.equal(statusBar.color, '#69b580');
  assert.equal(reviewView.badge.value, 2);
  assert.deepEqual(Array.from(messages.at(-1).history[0].tickets), ['LU-2', 'LU-1']);
  const localRow = messages.at(-1).history.find(row => row.id === firstReportId);
  assert.deepEqual([localRow.local.sha, localRow.local.link.state, localRow.result, localRow.local.onBranch], [review.commits[0], 'none', 'clean', true],
    'a reviewed commit of the checked-out branch is on it, for the current branch filter');
  // A finished patch in the Review list opens its report in Reports & History;
  // leaving Review clears the finished batch, whose reports stay NEW.
  assert.equal(messages.at(-1).section, 'review');
  await receive({type:'openBatchReport',key:'unknown'});
  assert.equal(messages.at(-1).section, 'review', 'a key outside the batch does nothing');
  await receive({type:'openBatchReport',key:review.commits[0]});
  assert.equal(messages.at(-1).section, 'history');
  assert.equal(messages.at(-1).historyTab, 'local');
  assert.equal(messages.at(-1).run.id, firstReportId);
  assert.equal(messages.at(-1).statsRun, undefined, 'leaving Review clears a finished batch');
  assert.equal(saved.get('statsCleared'), true);
  assert.equal(messages.at(-1).unreadCount, 2, 'its reports stay NEW');
  await receive({type:'section',value:'history'});
  assert.equal(messages.at(-1).section, 'history');
  assert.equal(messages.at(-1).selected,0,'completion clears local selection');
  await receive({type:'selection',repository:repositoryId,sha:commits[0].sha,checked:true});
  assert.equal(messages.at(-1).statsRun, undefined, 'new selection clears old statistics');
  assert.equal(messages.at(-1).run.id, firstReportId, 'report history is retained');
  assert.equal(saved.get('statsCleared'), true);
  assert.equal(messages.at(-1).reviewStatus, 'completed', 'unread result remains discoverable after changing the draft');
  assert.equal(reviewView.badge.value, 2);
  assert.match(reviewView.badge.tooltip, /LU-2: second/);
  await receive({type:'history',id:firstReportId});
  assert.equal(messages.at(-1).statsRun, undefined, 'history never restores old Review statistics');
  assert.equal(messages.at(-1).run.id, firstReportId);
  assert.equal(messages.at(-1).historyTab, 'local');
  assert.equal(messages.at(-1).git.installed, true, 'Git is checked like lreview');
  await receive({type:'reviewDiff',id:firstReportId});
  const localDiff = executed.filter(([id]) => id === 'vscode.changes').at(-1);
  assert.equal(localDiff[2][0][0].path, '/COMMIT_MSG');
  assert.ok(localDiff[2].some(entry => entry[0].path === '/file.c'), 'the reviewed commit is compared with its parent');
  assert.equal(messages.at(-1).run.summary.findings.total, 0);
  assert.equal(messages.at(-1).run.isNew, true, 'an unopened report remains NEW');
  await receive({type:'reports'});
  assert.equal(reports().length, 1, 'only the selected commit report opens');
  assert.ok(reports().at(-1).document.fsPath.includes(review.commits[0]));
  assert.equal(reviewView.badge.value, 1, 'the other commit remains NEW');
  assert.equal(messages.at(-1).run.isNew, false);
  await receive({type:'history',id:secondReportId});
  assert.equal(messages.at(-1).run.isNew, true);
  await receive({type:'reports'});
  assert.equal(reports().length, 2);
  assert.ok(reports().at(-1).document.fsPath.includes(review.commits[1]));
  assert.equal(messages.at(-1).statsRun, undefined);
  assert.equal(reviewView.badge.value, 0);
  assert.equal(activityBadge, 0);
  assert.equal(messages.at(-1).reviewStatus, 'idle');
  await receive({type:'history',id:firstReportId});
  assert.equal(messages.at(-1).statsRun, undefined);
  const originalLreview = settings.lreviewPath;
  settings.lreviewPath = path.join(repo.directory, 'missing-lreview');
  configurationListener({affectsConfiguration:key=>key==='lustreReview' || key==='lustreReview.lreviewPath'});
  await until(() => messages.at(-1).lreview.status === 'missing');
  await receive({type:'run'});
  assert.equal(messages.at(-1).section, 'settings');
  assert.equal(messages.at(-1).settingsTab, 'utilities', 'a missing lreview opens the Utilities tab');
  assert.equal(messages.at(-1).busy, false);
  assert.match(errors.pop(), /Install lreview/);
  await receive({type:'settingsTab',value:'other'});
  assert.equal(messages.at(-1).settingsTab, 'other');
  assert.equal(saved.get('settingsTab'), 'other', 'the chosen category is remembered');
  await receive({type:'settingsTab',value:'nowhere'});
  assert.equal(messages.at(-1).settingsTab, 'other');
  await receive({type:'lreviewDownload'});
  assert.equal(external.at(-1), 'https://github.com/lustre-tools/llm_code_and_review_tools');
  settings.lreviewPath = originalLreview;
  configurationListener({affectsConfiguration:key=>key==='lustreReview' || key==='lustreReview.lreviewPath'});
  await until(() => messages.at(-1).lreview.installed);
  pickIndex = 1;
  await receive({type:'model'});
  assert.equal(messages.at(-1).model.id, 'sonnet');
  assert.equal(messages.at(-1).statsRun, undefined, 'new model clears old statistics');
  await receive({type:'section',value:'review'});
  await until(() => messages.at(-1).accountLimits.snapshot);
  assert.equal(messages.at(-1).accountLimits.agent, 'claude');
  assert.equal(messages.at(-1).accountLimits.snapshot.windows[0].usedPercent, 10);
  await until(() => messages.length > 2);
  assert.deepEqual(errors, []);

  // Reload a workspace with review history and Augment selected. Repository
  // discovery has not run when cached account limits are restored at startup.
  const prior = api.getReview(review.id);
  await module.exports.deactivate();
  for (const d of context.subscriptions) d.dispose();
  context.subscriptions.length = 0;
  const augmentId = '11111111-1111-4111-8111-111111111111';
  const anotherId = '33333333-3333-4333-8333-333333333333';
  const closedId = '22222222-2222-4222-8222-222222222222';
  for (const [id, agent, repositoryId] of [[augmentId, 'auggie', prior.repository], [anotherId, 'claude', prior.repository], [closedId, 'codex', 'closed-repository']]) {
    const directory = path.join(context.storageUri.fsPath, 'runs', id);
    await fs.mkdir(directory, {recursive:true});
    await fs.cp(path.join(context.storageUri.fsPath, 'runs', prior.id, 'artifacts'), path.join(directory, 'artifacts'), {recursive:true});
    await fs.writeFile(path.join(directory, 'run.json'), JSON.stringify({...prior,id,agent,repository:repositoryId,directory,
      usage:{tokens:null,limits:agent==='codex'?{windows:[{minutes:10080,usedPercent:59}],observedAt:new Date().toISOString()}:undefined}}));
  }
  const cancelledId = '44444444-4444-4444-8444-444444444444';
  const cancelledDirectory = path.join(context.storageUri.fsPath, 'runs', cancelledId);
  await fs.mkdir(cancelledDirectory, {recursive:true});
  await fs.writeFile(path.join(cancelledDirectory, 'run.json'), JSON.stringify({...prior,id:cancelledId,
    commits:[prior.commits[0]],status:'cancelled',results:[],usage:{},error:'claude exited 143'}));
  saved.set('agent', 'auggie');
  saved.set('model:auggie', {id:'augment-test',name:'Saved Augment model',efforts:[]});
  saved.set('section', null);
  providers.clear(); commands.clear(); messages.length = 0;
  const reloaded = await module.exports.activate(context);
  providers.get('lustreReview.review').resolveWebviewView(reviewView);
  await receive({type:'ready'});
  assert.equal(messages.at(-1).agent, 'auggie');
  assert.equal(messages.at(-1).section, 'review', 'a saved all-collapsed layout opens Review');
  assert.equal(messages.at(-1).model.id, 'augment-test');
  assert.equal(messages.at(-1).commits.length, 2);
  assert.equal(messages.at(-1).history.length, 6, 'saved reviews for the open repository survive reload');
  // Reports & History keeps only successful reviews: a cancelled one is deleted with its files.
  assert.equal(await fs.stat(cancelledDirectory).then(() => true, () => false), false, 'a cancelled review is deleted, not hidden');
  assert.ok(!messages.at(-1).history.some(row => row.runId === cancelledId));
  await until(() => messages.at(-1).mcpSetup.codex.configured && messages.at(-1).mcpSetup.auggie.configured);
  assert.equal(messages.at(-1).mcpSetup.codex.status,'configured','Codex configuration is rediscovered after reload without another click');
  assert.equal(messages.at(-1).mcpSetup.auggie.status,'configured','Auggie configuration is rediscovered after reload');
  const configFile=path.join(repo.directory,'codex-mcp.json');
  const mcpOriginal=JSON.parse(await fs.readFile(configFile,'utf8'));
  const mcpOther=structuredClone(mcpOriginal);mcpOther.transport.args[mcpOther.transport.args.length-1]='/other/window/connection.json';
  await fs.writeFile(configFile,JSON.stringify(mcpOther));
  await receive({type:'connections'});
  await until(()=>messages.at(-1).mcpSetup.codex.status==='otherWorkspace');
  assert.equal(messages.at(-1).mcpSetup.codex.configured,false,'another window is never shown as configured here');
  await fs.writeFile(configFile,JSON.stringify(mcpOriginal));
  await receive({type:'connections'});
  await until(()=>messages.at(-1).mcpSetup.codex.configured);
  assert.equal(reloaded.getReview(augmentId).status, 'completed');
  assert.equal(reloaded.getReview(review.id).status, 'completed');
  assert.throws(() => reloaded.getReview(closedId), /open workspace repositories/, 'MCP still rejects reviews from a closed repository');
  assert.equal(reports().length, 2, 'reload does not reopen old reports');
  await until(() => messages.at(-1).unreadCount === 4);
  assert.equal(messages.at(-1).autoOpenReports, false, 'checkbox preference survives reload');
  assert.equal(messages.at(-1).unreadCount, 4, 'unread marks persist, excluding closed repositories');
  assert.equal(reviewView.badge.value, 4);
  await receive({type:'history',id:`${augmentId}:${prior.commits[0]}`});
  assert.equal(messages.at(-1).run.isNew, true);
  assert.equal(messages.at(-1).statsRun, undefined);
  await fs.unlink(path.join(context.storageUri.fsPath, 'runs', augmentId, 'artifacts', 'markdown', prior.commits[0]+' Report.md'));
  await receive({type:'reports'});
  assert.match(errors.pop(), /No Markdown report/);
  assert.equal(messages.at(-1).run.hasReport, false);
  assert.equal(messages.at(-1).run.isNew, false, 'deleted files cannot produce NEW');
  assert.equal(messages.at(-1).unreadCount, 3);
  assert.ok(!saved.get('readReports').includes(`${augmentId}:${prior.commits[0]}`), 'missing files are not marked opened');
  await receive({type:'clearNotifications'});
  assert.equal(messages.at(-1).unreadCount, 0);
  assert.equal(messages.at(-1).run.isNew, false);
  assert.equal(reviewView.badge.value, 0);
  assert.equal(activityBadge, 0);
  assert.equal(messages.at(-1).history.length, 6, 'clearing notifications retains the reports');
  assert.ok(saved.get('readReports').includes(`${augmentId}:${prior.commits[1]}`));
  assert.ok(saved.get('readReports').includes(`${anotherId}:${prior.commits[0]}`));
  await receive({type:'autoOpenReports',value:true});
  const automatic = await reloaded.startReview({agent:'claude',commits:['HEAD~1','HEAD'],source:'mcp'});
  failReport = automatic.commits[1];
  await until(() => errors.some(error => error.includes('Editor could not open')));
  assert.match(errors.pop(), /Editor could not open/);
  assert.equal(reports().length, 3);
  assert.equal(messages.at(-1).unreadCount, 1, 'only the tab that failed to open remains NEW');
  assert.equal(reports().at(-1).options.preview, false);
  assert.equal(reports().at(-1).options.preserveFocus, false);
  assert.ok(saved.get('readReports').includes(`${automatic.id}:${automatic.commits[0]}`));
  assert.ok(!saved.get('readReports').includes(`${automatic.id}:${automatic.commits[1]}`));
  failReport = undefined;
  await commands.get('lustreReview.status')();
  assert.equal(messages.at(-1).section, 'history');
  assert.equal(messages.at(-1).run.id, `${automatic.id}:${automatic.commits[1]}`);
  await receive({type:'reports'});
  assert.equal(reports().length, 4);
  assert.equal(messages.at(-1).unreadCount, 0);

  // An interrupted process with no Markdown must not offer a report or NEW.
  await fs.writeFile(path.join(repo.directory,'cancel-next'), '');
  const cancelled = await reloaded.startReview({agent:'claude',commits:['HEAD'],source:'mcp'});
  await until(() => reloaded.getReview(cancelled.id).log.includes('run started'));
  // A running batch cannot take more targets: its end would silently drop them.
  await until(() => messages.at(-1).busy === true);
  const selectedDuringRun = messages.at(-1).selected;
  const unselected = messages.at(-1).commits.find(commit => !commit.selected);
  await receive({type:'selection',repository:messages.at(-1).repositoryId,sha:unselected.sha,checked:true});
  assert.equal(messages.at(-1).selected, selectedDuringRun, 'commits cannot be selected during a review');
  for (const message of [{type:'selectAll'},{type:'clearSelection'},{type:'repository'},
    {type:'addGerritPatch',url:'https://review.whamcloud.com/64086/2'},{type:'removeGerritPatch',number:64086}]) {
    await receive(message);
    assert.match(errors.pop(), /Wait for the current review to finish/, `${message.type} is refused during a review`);
  }
  assert.equal(messages.at(-1).selected, selectedDuringRun);
  assert.equal(messages.at(-1).gerritPatches.items.length, 0);
  await receive({type:'cancel'});
  await until(() => reloaded.getReview(cancelled.id).status === 'cancelled');
  await receive({type:'history',id:cancelled.id});
  assert.equal(messages.at(-1).run.hasReport, false);
  assert.equal(messages.at(-1).run.isNew, false);
  assert.equal(messages.at(-1).unreadCount, 0);
  await receive({type:'clearNotifications'});
  assert.equal(activityBadge, 0);
  assert.equal(reports().length, 4, 'no tabs open for a cancelled run without a report');
  await fs.unlink(path.join(repo.directory,'cancel-next'));
  // Cancelled is the status; the lreview process may still be exiting. Start
  // the next review once the service is free, as a user could.
  await until(() => messages.at(-1).busy === false);
  const ongoing = await reloaded.startReview({agent:'claude',commits:['HEAD'],source:'mcp'});
  const sectionNow = messages.at(-1).section;
  await receive({type:'section',value:'review'});
  await receive({type:'section',value:'commits'});
  assert.equal(saved.get('statsCleared'), false, 'leaving Review keeps a running batch');
  assert.equal(messages.at(-1).statsRun.id, ongoing.id);
  await receive({type:'section',value:sectionNow});
  await receive({type:'history',id:firstReportId});
  assert.equal(messages.at(-1).run.id, firstReportId);
  assert.equal(messages.at(-1).statsRun.id, ongoing.id, 'history does not replace the live review');
  await until(() => reloaded.getReview(ongoing.id).usage?.sampledAt);
  await receive({type:'ready'});
  assert.equal(messages.at(-1).run.id, firstReportId, 'live sampling does not change the selected history item');
  assert.equal(messages.at(-1).statsRun.id, ongoing.id);
  const totalsBeforeClear = JSON.stringify(messages.at(-1).usageStatistics);
  await receive({type:'clearHistory'});
  assert.equal(JSON.stringify(messages.at(-1).usageStatistics), totalsBeforeClear, 'Clear history preserves accumulated usage');
  await receive({type:'resetStatistics'});
  assert.match(errors.pop(), /Wait for the current review/);
  assert.equal(messages.at(-1).history.length, 1, 'active reviews survive Clear history');
  assert.equal(messages.at(-1).statsRun.id, ongoing.id);
  assert.equal(reloaded.getReview(review.id).status, 'completed', 'clearing the list retains reports and the MCP record');
  assert.ok(saved.get('hiddenHistory').includes(review.id));
  assert.ok(!saved.get('hiddenHistory').includes(ongoing.id));
  await until(() => reports().length === 5 && messages.at(-1).statsRun === undefined);
  await receive({type:'ready'});
  assert.equal(messages.at(-1).unreadCount, 0, 'automatic tabs acknowledge successfully opened reports');
  assert.equal(messages.at(-1).statsRun, undefined, 'automatic opening resets Review');
  assert.equal(activityBadge, 0);
  assert.ok(saved.get('readReports').includes(ongoing.id));
  await receive({type:'clearHistory'});
  assert.equal(messages.at(-1).history.length, 0);
  assert.equal(messages.at(-1).run, undefined);
  const retained = reports().at(-1).document.fsPath;
  assert.match(await fs.readFile(retained, 'utf8'), /# Review completed\n\n## Overall assessment\n\n\\\[[^\]\n]*\\\]\n/);
  await module.exports.deactivate();
  for (const d of context.subscriptions) d.dispose();
  context.subscriptions.length = 0;
  const cleared = await module.exports.activate(context);
  providers.get('lustreReview.review').resolveWebviewView(reviewView);
  await receive({type:'ready'});
  assert.equal(messages.at(-1).history.length, 0, 'cleared history stays empty after reload');
  assert.equal(cleared.getReview(ongoing.id).status, 'completed');
  assert.equal(messages.at(-1).autoOpenReports, true);
  assert.equal(messages.at(-1).usageStatistics.find(row => row.agent === 'claude').tokens, 17500, 'all workspace runs accrue once across reloads, including hidden history');
  const totalsOnReload = JSON.stringify(messages.at(-1).usageStatistics);
  await receive({type:'ready'});
  assert.equal(JSON.stringify(messages.at(-1).usageStatistics), totalsOnReload);
  await receive({type:'resetStatistics'});
  assert.deepEqual(messages.at(-1).usageStatistics, []);
  assert.equal(cleared.getReview(ongoing.id).status, 'completed', 'reset leaves reviews intact');
  await module.exports.deactivate();
  for (const d of context.subscriptions) d.dispose();
  context.subscriptions.length = 0;
  const reset = await module.exports.activate(context);
  providers.get('lustreReview.review').resolveWebviewView(reviewView);
  await receive({type:'ready'});
  assert.deepEqual(messages.at(-1).usageStatistics, [], 'reset survives backfill of retained files');
  const afterReset = await reset.startReview({agent:'claude',commits:['HEAD'],source:'mcp'});
  await until(() => reset.getReview(afterReset.id).status === 'completed');
  await receive({type:'ready'});
  assert.equal(messages.at(-1).usageStatistics[0].tokens, 2500, 'only reviews started after reset are counted');
  assert.equal(messages.at(-1).usageStatistics[0].cost, 0.1234);
  await until(()=>messages.at(-1).busy===false);
  await receive({type:'autoOpenReports',value:false});
  await receive({type:'agent',value:'claude'});
  await receive({type:'clearSelection'});
  await receive({type:'addGerritPatch',url:'https://review.whamcloud.com/64086/2'});
  await Promise.all([receive({type:'run'}), receive({type:'run'})]);
  assert.deepEqual(errors, []);
  const remoteId=messages.at(-1).statsRun.id;
  await until(()=>reset.getReview(remoteId).status==='completed');
  await until(()=>messages.at(-1).gerritHistory.some(r=>r.runId===remoteId&&r.hasReport));
  // The list gets one compact row per review: what the row, filters and card show, no findings or log.
  const remoteRow=messages.at(-1).gerritHistory.find(row=>row.runId===remoteId);
  assert.deepEqual([remoteRow.gerrit.change,remoteRow.gerrit.ps,remoteRow.gerrit.branch,remoteRow.result,remoteRow.gerrit.published],[64086,2,'master','clean',false]);
  assert.equal(Object.keys(remoteRow.kinds).length,0,'a clean review has no findings by type');
  assert.ok(!('results' in remoteRow)&&!('log' in remoteRow)&&!('usage' in remoteRow));
  assert.deepEqual(reset.getReview(remoteId).commits,['gerrit:64086:2']);
  assert.equal(reset.getReview(remoteId).results[0].status,'clean');
  assert.equal(messages.at(-1).selected,0);
  assert.equal(messages.at(-1).gerritPatches.items.length,0);
  assert.equal(messages.at(-1).reviewStatus,'completed','duplicate clicks do not leave a stale red indicator');
  assert.equal(statusBar.color,'#69b580');
  assert.ok(!messages.at(-1).history.some(r=>r.runId===remoteId),'Gerrit history is separate');
  assert.equal(messages.at(-1).historyTab,'gerrit','a new Gerrit review opens the Gerrit tab');
  assert.equal(messages.at(-1).gerritRun.id,remoteId,'and is shown without choosing it');
  assert.equal(messages.at(-1).gerritRun.gerritPatch.owner,'Gerrit Author','the owner from the patch list is kept');
  assert.equal(messages.at(-1).gerritRun.gerritPatch.patchset,2);
  assert.equal(messages.at(-1).gerritRun.gerritPatch.branch,'master','the target branch from the patch list is kept');
  assert.equal(messages.at(-1).diffScope,'commented','the diff shows files with comments by default');
  await receive({type:'reviewDiff',id:remoteId,scope:messages.at(-1).diffScope});
  const gerritDiff = executed.filter(([id]) => id === 'vscode.changes').at(-1);
  assert.equal(gerritDiff[1],'Review · LU-12345: Gerrit patch · PS 2 · files with comments · 1 unresolved in Gerrit',
    'a clean review still shows the files under discussion in Gerrit');
  const discussion=commentThreads.filter(thread=>thread.label==='Gerrit · unresolved'&&!thread.disposed);
  assert.deepEqual(discussion.map(thread=>[thread.uri.path,thread.range.startLine,thread.comments[0].author.name,thread.comments[0].body.value]),
    [['/file.c',0,'Other Reviewer','Please explain this line.']],'only the reviewed patchset’s unresolved discussion is shown');
  assert.deepEqual(gerritDiff[2].map(entry=>entry[0].path),['/file.c'],'the message has no comments, so only the discussed file is shown');
  await receive({type:'diffScope',value:'all'});
  assert.equal(messages.at(-1).diffScope,'all');
  assert.equal(saved.get('diffScope'),'all','the chosen scope is remembered');
  await receive({type:'reviewDiff',id:remoteId,scope:'all'});
  assert.match(executed.filter(([id]) => id === 'vscode.changes').at(-1)[1],/ · all files · 1 unresolved in Gerrit$/);
  await receive({type:'diffScope',value:'other'});
  assert.equal(messages.at(-1).diffScope,'all');
  await receive({type:'diffScope',value:'commented'});
  await receive({type:'reviewDiff',id:'unknown'});
  assert.match(errors.pop(),/Choose a review/);
  await receive({type:'history',id:remoteId});
  assert.equal(messages.at(-1).historyTab,'gerrit','a Gerrit id never selects a local review');
  await receive({type:'historyTab',value:'local'});
  assert.equal(messages.at(-1).historyTab,'local');
  assert.equal(messages.at(-1).gerritRun.id,remoteId,'the Gerrit choice is kept on the other tab');
  await receive({type:'historyTab',value:'other'});
  assert.equal(messages.at(-1).historyTab,'local');
  await receive({type:'gerritHistory',id:remoteId});
  assert.equal(messages.at(-1).historyTab,'gerrit');
  await until(()=>messages.at(-1).gerritRun?.publication.status==='ready');
  // Shown under Publish: someone else's AI review of the reviewed patchset only.
  const sectionBefore=messages.at(-1).section;
  // General information: Gerrit now has PS 3, which changes the file with the finding.
  await fs.writeFile(path.join(repo.directory,'newer-patchset'),'');
  await receive({type:'section',value:'history'});
  await until(()=>messages.at(-1).gerritRun?.gerritState?.changed);
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1).gerritRun.gerritState)),{kind:'gerrit',number:64086,reviewed:2,current:3,status:'NEW',conflict:true,
    build:'passed',tests:'failed',votes:[{name:'Other Reviewer',value:1}],changed:['file.c'],loading:false});
  await fs.unlink(path.join(repo.directory,'newer-patchset'));
  await receive({type:'openReportChange',id:remoteId});
  assert.equal(external.at(-1),'https://review.whamcloud.com/c/fs/lustre-release/+/64086');
  await until(()=>messages.at(-1).gerritRun?.otherAiReviews);
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1).gerritRun.otherAiReviews)),
    [{author:'Chris Horn',signature:'AI review - opus',count:1,at:'2026-10-17T18:30:58.000Z'}]);
  assert.equal(messages.at(-1).gerritRun.publication.status,'ready','another AI review does not block publishing');
  await receive({type:'section',value:sectionBefore});
  await receive({type:'historyTab',value:'local'});
  await receive({type:'openBatchReport',key:'gerrit:64086:2'});
  assert.equal(messages.at(-1).historyTab,'gerrit','a finished Gerrit patch on Review opens its Gerrit report');
  assert.equal(messages.at(-1).gerritRun.id,remoteId);
  assert.equal(messages.at(-1).section,'history');
  await receive({type:'section',value:sectionBefore});
  const remoteSignature=reset.getReview(remoteId).signature;
  assert.equal(remoteSignature,'[Lustre Bot]','signature details default to disabled');
  await receive({type:'gerritSignatureDetails',value:true});
  await receive({type:'gerritBotName',value:'Changed bot'});
  await receive({type:'gerritReports',id:remoteId});
  const markdown=await fs.readFile(reports().at(-1).document.fsPath,'utf8');
  assert.match(markdown,/## Overall assessment/);
  assert.ok(markdown.includes('Lustre Bot'),'report keeps the signature captured at review time');
  assert.equal(messages.at(-1).gerritRun.isNew,false);
  // Another window already published this patchset: a patchset gets one AI review.
  const registryPath=path.join(repo.directory,'global','publications.json');
  const before=await fs.readFile(registryPath,'utf8').catch(()=>JSON.stringify({version:1,publications:[]}));
  await fs.writeFile(registryPath,JSON.stringify({version:1,publications:[...JSON.parse(before).publications,
    {project:'fs/lustre-release',change:64086,patchset:2,run:'88888888-8888-8888-8888-888888888888',signature:'[Elsewhere]',postedAt:'2026-10-16T10:00:00.000Z'}]}));
  await receive({type:'publishGerrit',id:remoteId});
  assert.match(errors.pop(),/PS 2 of change #64086 was already published .* as \[Elsewhere\]\. A patchset gets one AI review\./);
  assert.equal(messages.at(-1).gerritRun.publication.status,'ready','nothing was posted');
  assert.equal(messages.at(-1).gerritRun.sharedPublication.signature,'[Elsewhere]');
  await assert.rejects(fs.readFile(path.join(repo.directory,'published.jsonl'),'utf8'),'lreview post never ran');
  await new Promise(resolve=>setTimeout(resolve,20));
  await fs.writeFile(registryPath,before);
  await Promise.all([receive({type:'publishGerrit',id:remoteId}),receive({type:'publishGerrit',id:remoteId})]);
  assert.equal(messages.at(-1).gerritRun.publication.status,'posted');
  assert.ok(Date.parse(messages.at(-1).gerritRun.publication.postedAt),'the publication time is available for the button');
  const registryFile=path.join(repo.directory,'global','publications.json');
  const registered=JSON.parse(await fs.readFile(registryFile,'utf8')).publications;
  assert.deepEqual(registered.map(entry=>[entry.project,entry.change,entry.patchset,entry.run,entry.owner,entry.branch]),
    [['fs/lustre-release',64086,2,remoteId,'Gerrit Author','master']],'a publication is recorded for every window, keyed by Gerrit project');
  assert.equal(messages.at(-1).gerritRun.sharedPublication,undefined,'its own publication is not reported as another one');
  const posted=JSON.parse((await fs.readFile(path.join(repo.directory,'published.jsonl'),'utf8')).trim());
  assert.equal(posted[0],'post');
  assert.equal(posted.at(-1),remoteSignature);
  await receive({type:'publishGerrit',id:remoteId});
  assert.equal((await fs.readFile(path.join(repo.directory,'published.jsonl'),'utf8')).trim().split('\n').length,1);
  await receive({type:'addGerritPatch',url:'https://review.whamcloud.com/64086/2'});
  assert.equal(messages.at(-1).gerritPatches.items.length,1);
  await module.exports.deactivate();
  for (const d of context.subscriptions) d.dispose();
  context.subscriptions.length=0;
  // Give the saved Gerrit result a finding to follow it in the Comments panel.
  const remoteFile=path.join(repo.directory,'storage','runs',remoteId,'run.json');
  const remoteRun=JSON.parse(await fs.readFile(remoteFile,'utf8'));
  remoteRun.results[0].comments=[{file:'file.c',line:1,message:'(defect) Check this.'}];
  await fs.writeFile(remoteFile,JSON.stringify(remoteRun));
  // Another window, possibly another clone of the project, published the same patchset later.
  const shared=JSON.parse(await fs.readFile(registryFile,'utf8'));
  shared.publications.push({project:'fs/lustre-release',change:64086,patchset:2,run:'99999999-9999-9999-9999-999999999999',
    signature:'[Other window]',postedAt:'2099-01-01T00:00:00.000Z'});
  await fs.writeFile(registryFile,JSON.stringify(shared));
  commentThreads.length=0;
  await module.exports.activate(context);
  providers.get('lustreReview.review').resolveWebviewView(reviewView);
  await receive({type:'ready'});
  assert.equal(messages.at(-1).gerritPatches.items.length,0,'reload clears the preparation list');
  assert.equal(commentThreads.length,0,'nothing is chosen after reload, so the Comments panel is empty');
  assert.equal(messages.at(-1).selected,0,'completed local selection stays cleared');
  assert.equal(messages.at(-1).historyTab,'local','reload opens the Local tab');
  assert.equal(messages.at(-1).run,undefined,'reload does not choose a review');
  assert.equal(messages.at(-1).gerritRun,undefined);
  await receive({type:'reports'});
  assert.match(errors.pop(),/Choose a report/);
  await receive({type:'gerritHistory',id:remoteId});
  await until(()=>messages.at(-1).gerritRun?.publication.status==='posted');
  assert.equal(messages.at(-1).gerritRun.gerritPatch.owner,'Gerrit Author','the owner survives reload');
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1).gerritRun.sharedPublication)),{postedAt:'2099-01-01T00:00:00.000Z',signature:'[Other window]'},
    'a publication of the same patchset from another window is shown');
  // Agents read the review chosen in the sidebar and look up reviews by commit.
  const { bridgeRequest } = require('../src/bridge');
  const connectionFile = path.join(repo.directory, 'storage', 'connection.json');
  const chosen = await bridgeRequest(connectionFile, 'get_selected_review', {});
  assert.deepEqual([chosen.review, chosen.tab, chosen.match, chosen.published, chosen.gerrit.change, chosen.gerrit.patchset],
    [remoteId, 'gerrit', 'selected', true, 64086, 2]);
  assert.deepEqual(chosen.findings, [{ file: 'file.c', line: 1, message: '(defect) Check this.' }]);
  assert.equal(chosen.report_files.length, 1);
  const lookup = await bridgeRequest(connectionFile, 'find_reviews', { commits: ['HEAD'] });
  assert.equal(lookup.commits.length, 1);
  assert.ok(Array.isArray(lookup.commits[0].reviews));
  // And the Gerrit state the panels show: the report's, by change, the queue and the commit links.
  assert.deepEqual([chosen.gerrit_state.change, chosen.gerrit_state.reviewed_patchset, chosen.gerrit_state.newer_patchset, chosen.gerrit_state.published],
    [64086, 2, false, true]);
  assert.deepEqual(chosen.gerrit_state.other_ai_reviews.map(review => [review.author, review.signature]), [['Chris Horn', 'AI review - opus']]);
  const byChange = await bridgeRequest(connectionFile, 'find_reviews', { change: 'https://review.whamcloud.com/c/fs/lustre-release/+/64086/2' });
  assert.deepEqual([byChange.change, byChange.reviews[0].review, byChange.reviews[0].gerrit_state.change], [64086, remoteId, 64086]);
  const gerritQueue = await bridgeRequest(connectionFile, 'get_gerrit_queue', {});
  assert.equal(gerritQueue.project, 'fs/lustre-release');
  // 64086 was published above, so it moved from Waiting Review to In progress.
  assert.deepEqual(gerritQueue.waiting_review, []);
  const published = gerritQueue.in_progress.find(item => item.change === 64086), replied = gerritQueue.in_progress.find(item => item.change === 64087);
  assert.deepEqual([published.state, published.ai_review, published.ci, published.url],
    ['waiting_for_author', 'published', 'passed', 'https://review.whamcloud.com/c/fs/lustre-release/+/64086']);
  assert.deepEqual(published.other_ai_reviews.map(review => review.author), ['Chris Horn']);
  assert.deepEqual([replied.state, replied.owner_replied_at], ['owner_replied', '2026-10-18T09:00:00.000Z']);
  const remoteReview = await bridgeRequest(connectionFile, 'get_review', { id: remoteId });
  assert.deepEqual(remoteReview.reports.map(report => [report.gerrit.change, report.gerrit_state.reviewed_patchset]), [[64086, 2]]);
  assert.equal((await bridgeRequest(connectionFile, 'list_commits', { limit: 1 })).length, 1);
  await until(()=>commentThreads.some(thread=>!thread.disposed));
  const live=()=>commentThreads.filter(thread=>!thread.disposed);
  assert.deepEqual(live().map(thread=>[thread.uri.path,thread.range.startLine,thread.comments[0].body.value]),[['/file.c',0,'(defect) Check this.']],
    'choosing a review shows its findings in the Comments panel');
  await receive({type:'historyTab',value:'local'});
  await until(()=>live().length===0);
  await receive({type:'historyTab',value:'gerrit'});
  await until(()=>live().length===1);
  await receive({type:'reviewDiff',id:remoteId,scope:'commented'});
  assert.deepEqual(live().map(thread=>thread.label??'finding'),['Defect','Gerrit · unresolved'],
    'the diff reuses the findings already shown and adds the Gerrit discussion');
  assert.deepEqual(executed.filter(([id])=>id==='vscode.changes').at(-1)[2].map(entry=>entry[0].path),['/file.c']);
  // A file with findings opens on its own from General information.
  await receive({type:'reviewDiffFile',id:remoteId,file:'other.c'});
  assert.ok(!executed.some(([id])=>id==='vscode.diff'),'only a file the review commented on opens');
  await receive({type:'reviewDiffFile',id:remoteId,file:'file.c'});
  assert.equal(executed.filter(([id])=>id==='vscode.diff').at(-1)[3],'Review · LU-12345: Gerrit patch · PS 2 · file.c');
  assert.equal(messages.at(-1).gerritSignatureDetails,true,'signature preference survives reload');
  // Commits already on the remote branch the work is based on are hidden by default.
  assert.equal(messages.at(-1).mergedBase,undefined,'without remote branches nothing is hidden');
  const rootSha=repo.git('rev-list','--max-parents=0','HEAD');
  repo.git('update-ref','refs/remotes/origin/master',rootSha);
  await receive({type:'refresh'});
  await until(()=>messages.at(-1).mergedBase==='origin/master');
  assert.equal(messages.at(-1).hideMerged,true);
  assert.equal(messages.at(-1).mergedCount,1);
  assert.equal(messages.at(-1).commits.length,messages.at(-1).totalCommits-1,'merged commits are hidden');
  assert.ok(!messages.at(-1).commits.some(c=>c.sha===rootSha));
  await receive({type:'toggleMerged'});
  assert.equal(messages.at(-1).hideMerged,false);
  assert.equal(messages.at(-1).commits.find(c=>c.sha===rootSha).merged,true,'shown merged commits are marked');
  await receive({type:'selection',repository:messages.at(-1).repositoryId,sha:rootSha,checked:true});
  assert.ok(messages.at(-1).selectedCommits.some(c=>c.sha===rootSha));
  await receive({type:'toggleMerged'});
  assert.equal(messages.at(-1).hideMerged,true);
  assert.ok(!messages.at(-1).selectedCommits.some(c=>c.sha===rootSha),'hiding merged commits deselects them');
  assert.equal(saved.get('hideMerged'),true);
  assert.deepEqual(errors, []);
});
