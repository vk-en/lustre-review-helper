'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ReviewService } = require('./service');
const { executable, extensionCodexPaths, listModels, readLimits: readCodexLimits } = require('./codex');
const { extensionClaudePaths, listModels: listClaudeModels, readLimits: readClaudeLimits } = require('./claude');
const { AccountLimits } = require('./limits');
const { AGENTS, AgentConnections } = require('./auth');
const { listModels: listAuggieModels } = require('./auggie');
const { repositoryRoot, currentBranch, git, mergedCommits, landedCommits } = require('./git');
const { startBridge } = require('./bridge');
const { reviewHtml } = require('./view');
const { finished, title: reviewTitle, summarize, findings: findingCounts, reports: patchReports } = require('./history');
const { resultKey } = require('./review-targets');
const { lreviewVersion, gitStatus: readGitStatus, GIT_URL } = require('./prerequisites');
const { ReviewDiff, SCHEME: DIFF_SCHEME } = require('./review-diff');
const { readComments, forPatchset } = require('./gerrit-comments');
const { findReviews, reviewDetails, commitInfo } = require('./review-lookup');
const { connectMcp, checkMcp } = require('./mcp-setup');
const { GlobalStatistics } = require('./global-statistics');
const { PublicationRegistry } = require('./publication-registry');
const { GERRIT_URL, findGerrit, configFile: gerritConfigFile, GerritConnection, botName } = require('./gerrit');
const { GerritPatches } = require('./gerrit-patches');
const { repositoryProject } = require('./gerrit-project');
const { GerritQueue, filters: queueFilterState, FILTERS: QUEUE_FILTERS, DEFAULT_FILTERS: QUEUE_DEFAULTS, readTimeline, aiReviews, AUTO_REFRESH } = require('./gerrit-queue');
const { GerritLinks, readChange, changeDetails, readPatchsetFiles, searchChanges } = require('./gerrit-links');
const { cleanupPlan } = require('./history-cleanup');
const { reviewSignature } = require('./signature');
const { GerritPublication } = require('./publication');
const { migrateStorage } = require('./migrate');
const l10n = require('./l10n');
const { t, tn } = l10n;
const LREVIEW_URL = 'https://github.com/lustre-tools/llm_code_and_review_tools';
const DASHBOARD_URL = 'https://github.com/lustre-tools/llm_code_and_review_tools/tree/main/gerrit_dashboard';
const GERRIT_ORIGIN = 'https://review.whamcloud.com';
const PATCHES_TABS = ['url', 'waiting', 'progress'];
const LAYOUTS = ['list', 'cards', 'groups'];

let shutdown;

async function activate(context) {
  if (!vscode.workspace.isTrusted) return;
  const config = () => vscode.workspace.getConfiguration('lustreReview');
  // The language of Lustre Review: chosen in AI Settings, or VS Code's when
  // it is one of ours, else English.
  const LANGUAGE_IDS = l10n.LANGUAGES.map(language => language.id);
  const languageSetting = () => LANGUAGE_IDS.includes(config().get('language')) ? config().get('language') : 'auto';
  let translation = l10n.use(l10n.resolveLanguage(languageSetting(), vscode.env.language));
  const languageInfo = () => ({ setting: languageSetting(), vscode: l10n.resolveLanguage('auto', vscode.env.language), active: translation.language });
  if (process.platform === 'win32') {
    vscode.window.showErrorMessage(t('Lustre Review Helper requires Linux, macOS, or a VS Code Remote WSL/SSH workspace (lreview uses POSIX worktrees and process groups).'));
    return;
  }
  const output = vscode.window.createOutputChannel('Lustre Review Helper');
  context.subscriptions.push(output);
  const storage = (context.storageUri || context.globalStorageUri).fsPath;
  // Published under a new identifier: its folders start with the old one's data.
  const migrated = await migrateStorage({ id: context.extension?.id, folders: [context.globalStorageUri?.fsPath, context.storageUri?.fsPath] })
    .catch(error => { output.appendLine(`Storage of the earlier identifier: ${error.message}`); return []; });
  for (const folder of migrated) output.appendLine(`Copied the reviews and statistics of the earlier identifier into ${folder}.`);
  const findCodex = () => executable('codex', config().get('codexPath'),
    extensionCodexPaths(vscode.extensions.getExtension('openai.chatgpt')?.extensionPath));
  const findClaude = () => executable('claude', config().get('claudePath'),
    extensionClaudePaths(vscode.extensions.getExtension('Anthropic.claude-code')?.extensionPath));
  const findLreview = () => executable('lreview', config().get('lreviewPath'));
  const findAuggie = () => executable('auggie', config().get('auggiePath'));
  const findGerritCli = async () => findGerrit(config().get('gerritPath'), await findLreview().catch(() => undefined));
  // gerrit-dashboard installs beside lreview and gerrit-cli.
  const findDashboard = async () => {
    const candidates = [];
    for (const tool of [await findLreview().catch(() => undefined), await findGerritCli().catch(() => undefined)].filter(Boolean)) {
      for (const location of [tool, await fs.realpath(tool).catch(() => tool)]) candidates.push(path.join(path.dirname(location), 'gerrit-dashboard'));
    }
    try { return await executable('gerrit-dashboard', config().get('gerritDashboardPath'), [...new Set(candidates)]); }
    catch { throw new Error(t('gerrit-dashboard was not found. Install it or set Lustre Review: Gerrit Dashboard Path.')); }
  };
  const agentLabel = value => ({ codex: 'Codex', claude: 'Claude Code', auggie: 'Augment' })[value];
  const service = new ReviewService({ storage: path.join(storage, 'runs'),
    signature: run => reviewSignature(config().get('gerritBotName', ''), run, config().get('gerritSignatureDetails', false)),
    discoverModels: async agent => agent === 'auggie' ? listAuggieModels(await findAuggie()) :
      agent === 'claude' ? listClaudeModels(await findClaude()) : listModels(await findCodex()),
    settings: async agent => ({
      lreview: await findLreview(),
      [agent]: await (agent === 'auggie' ? findAuggie() : agent === 'claude' ? findClaude() : findCodex()), promptsDir: config().get('promptsDir'),
      jobs: config().get('jobs'), timeout: config().get('timeout'), mode: config().get('mode'),
    }) });
  await service.initialize();
  await context.workspaceState.update('gerritPatches', undefined);
  const statistics = new GlobalStatistics({ file: path.join(context.globalStorageUri.fsPath, 'usage-statistics.json'),
    workspaceStorage: context.storageUri ? path.dirname(path.dirname(storage)) : undefined, extensionId: path.basename(storage) });
  await statistics.initialize({ legacy: context.workspaceState.get('usageStatistics'), runs: service.runs.values() });
  // Reviews published from any window, keyed by Gerrit project rather than folder.
  const registry = new PublicationRegistry({ file: path.join(context.globalStorageUri.fsPath, 'publications.json'),
    workspaceStorage: context.storageUri ? path.dirname(path.dirname(storage)) : undefined, extensionId: path.basename(storage) });
  await registry.initialize(service.runs.values()).catch(error => output.appendLine(`Published reviews: ${error.message}`));
  let statisticsTimer;
  const saveStatistics = () => {
    clearTimeout(statisticsTimer); statisticsTimer = undefined;
    return statistics.sync();
  };
  // Existing reports predate notification tracking; do not turn the entire archive NEW.
  const readReports = new Set(context.workspaceState.get('readReports', [...service.runs.values()].filter(finished).map(run => run.id)));
  await context.workspaceState.update('readReports', [...readReports]);
  const hiddenHistory = new Set(context.workspaceState.get('hiddenHistory', []));
  let autoOpenReports = context.workspaceState.get('autoOpenReports', true) !== false;
  const reportAvailability = new Map();
  const indexingReports = new Map();
  const openingReports = new Set();
  let currentReview = context.workspaceState.get('currentReview');
  let lreviewStatus = { status: 'checking', installed: false };
  let lreviewCheckedAt = 0, lreviewPending;
  async function checkLreview(force = false) {
    if (disposed) return;
    if (lreviewPending) { await lreviewPending; if (!force) return; }
    if (!force && Date.now() - lreviewCheckedAt < 30000) return;
    lreviewPending = (async () => {
      try {
        const binary = await findLreview();
        if (!(await fs.stat(binary)).isFile()) throw new Error('Not an executable file.');
        lreviewStatus = { status: 'installed', installed: true, path: binary }; update();
        lreviewStatus.version = await lreviewVersion(binary);
      } catch { lreviewStatus = { status: 'missing', installed: false }; }
      lreviewCheckedAt = Date.now(); update();
    })();
    try { await lreviewPending; } finally { lreviewPending = undefined; }
  }
  let gitState = { status: 'checking', installed: false };
  let gitCheckedAt = 0, gitPending;
  async function checkGit(force = false) {
    if (disposed) return;
    if (gitPending) { await gitPending; if (!force) return; }
    if (!force && Date.now() - gitCheckedAt < 30000) return;
    gitPending = readGitStatus().then(status => { gitState = status; gitCheckedAt = Date.now(); update(); });
    try { await gitPending; } finally { gitPending = undefined; }
  }

  let dashboardStatus = { status: 'checking', installed: false };
  let dashboardCheckedAt = 0, dashboardPending;
  async function checkDashboard(force = false) {
    if (disposed) return;
    if (dashboardPending) { await dashboardPending; if (!force) return; }
    if (!force && Date.now() - dashboardCheckedAt < 30000) return;
    dashboardPending = findDashboard().then(binary => ({ status: 'installed', installed: true, path: binary }), () => ({ status: 'missing', installed: false }))
      .then(status => { dashboardStatus = status; dashboardCheckedAt = Date.now(); update(); });
    try { await dashboardPending; } finally { dashboardPending = undefined; }
  }

  let selectedRepository;
  // The Gerrit project of the selected repository, for Waiting Review and In progress.
  let projectInfo;
  let branch = '';
  let commits = [];
  let selected = new Set();
  // Commits already on the branch this work is based on are hidden by default.
  let hideMerged = context.workspaceState.get('hideMerged', true) !== false;
  let mergedBase;
  let merged = new Set();
  const shown = () => hideMerged && mergedBase ? commits.filter(c => !merged.has(c.sha)) : commits;
  let agent = ['claude', 'auggie'].includes(context.workspaceState.get('agent')) ? context.workspaceState.get('agent') : 'codex';
  const savedModel = () => context.workspaceState.get(`model:${agent}`, agent === 'codex' ? context.workspaceState.get('model') : undefined);
  const savedEffort = () => context.workspaceState.get(`effort:${agent}`, agent === 'codex' ? context.workspaceState.get('effort', '') : '');
  let model = savedModel();
  let effort = savedEffort();
  let modelSequence = 0;
  let loadingModels = false;
  let mode = context.workspaceState.get('mode', config().get('mode'));
  let notice = '';
  let selectedRun;
  let selectedGerritRun;
  // Reports & History opens on Local after a restart, with no review chosen.
  let historyTab = 'local';
  const SETTINGS_TABS = ['accounts', 'agent', 'utilities', 'mcp', 'other', 'language'];
  let settingsTab = SETTINGS_TABS.includes(context.workspaceState.get('settingsTab')) ? context.workspaceState.get('settingsTab') : 'accounts';
  // The diff button keeps the last scope chosen from its menu, like GitHub's merge button.
  let diffScope = context.workspaceState.get('diffScope') === 'all' ? 'all' : 'commented';
  const showReview = review => {
    if (review.gerritPatches?.length) { selectedGerritRun = review.id; historyTab = 'gerrit'; }
    if (!review.gerritPatches?.length || review.localCommits?.length) { selectedRun = review.id; if (!review.gerritPatches?.length) historyTab = 'local'; }
  };
  let starting = false;
  let view;
  const sections = ['settings', 'commits', 'gerritPatches', 'review', 'history'];
  let section = context.workspaceState.get('section', 'commits');
  if (!sections.includes(section)) section = 'review';
  let logRun;
  let refreshSequence = 0;
  let disposed = false;
  let timer;
  let limitsTimer;
  let draftKey;
  let statsCleared = context.workspaceState.get('statsCleared', false);
  // Reports & History clean-up: Gerrit status of reviewed changes, when open
  // changes were last read, and the landed commits of each repository.
  const changeStatus = new Map(), changeInfoAt = new Map(), localChecks = new Map();
  let sweepChain = Promise.resolve(), lastGerritSweep = 0;
  let latestActiveId;
  let reviewError = false;
  const connectionStates = new Map();
  const authActions = new Set();
  const mcpActions = new Set();
  const mcpMessages = new Map();
  const mcpChecks = new Map();
  const mcpKey = (target, repository = selectedRepository) => `${target}:${target === 'codex' ? '' : repository?.id}`;
  const loginTerminals = new Map();
  const finders = { codex: findCodex, claude: findClaude, auggie: findAuggie };
  const gerritCwd = () => selectedRepository?.path || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || require('node:os').homedir();
  const gerrit = new GerritConnection(findGerritCli, () => update());
  const gerritPatches = new GerritPatches({ find: findGerritCli,
    cwd: () => selectedRepository?.path, changed: () => update() });
  const publication = new GerritPublication({ service, find: findLreview, changed: () => update() });
  // Changes where the Gerrit account is a reviewer; the last refresh of each
  // project is shared by all windows.
  const queue = new GerritQueue({ file: path.join(context.globalStorageUri.fsPath, 'gerrit-reviews.json'),
    dataDir: path.join(context.globalStorageUri.fsPath, 'gerrit-dashboard'), findDashboard, findGerrit: findGerritCli, changed: () => update() });
  await queue.load().catch(error => output.appendLine(`Gerrit reviews: ${error.message}`));
  // The Gerrit change of each local commit, for the link icon in Local commits.
  const links = new GerritLinks({ file: path.join(context.globalStorageUri.fsPath, 'gerrit-links.json'), findGerrit: findGerritCli, changed: () => update() });
  await links.load().catch(error => output.appendLine(`Gerrit links: ${error.message}`));
  const baseBranch = () => mergedBase?.includes('/') ? mergedBase.slice(mergedBase.indexOf('/') + 1) : mergedBase;
  const checkLinks = () => {
    if (!projectInfo?.project || !selectedRepository) return;
    void links.check(projectInfo.project, baseBranch(), shown(), selectedRepository.path).catch(error => output.appendLine(`Gerrit links: ${error.message}`));
  };
  let patchesTab = PATCHES_TABS.includes(context.workspaceState.get('patchesTab')) ? context.workspaceState.get('patchesTab') : 'url';
  let queueFilters = queueFilterState(context.workspaceState.get('queueFilters'));
  const patchesLayout = () => LAYOUTS.includes(config().get('gerritPatchesLayout')) ? config().get('gerritPatchesLayout') : 'list';
  const queueItems = () => { const data = queue.get(projectInfo?.project); return [...data.waiting, ...data.progress]; };
  // This extension's AI review of a change's current patchset: published, or
  // ready and not published, in this window or another.
  const queueMarks = (project, item) => {
    // One AI review per patchset: a published one turns the checkbox off.
    const posted = registry.find(project, item.number, item.ps);
    const ready = posted ? [] : registry.ready(project, item.number, item.ps).filter(entry => !hiddenHistory.has(entry.run));
    const here = ready.find(entry => service.runs.has(entry.run));
    return { ...(posted ? { published: { postedAt: posted.postedAt } } : {}),
      ...(ready.length ? { aiReady: here ? { here: true } : { here: false, folder: ready[0].folder } } : {}) };
  };
  const queueView = () => {
    const project = projectInfo?.project, data = queue.get(project), patches = gerritPatches.get();
    const chosen = new Set(patches.items.map(item => item.number)), adding = new Set(patches.adding);
    const decorate = item => ({ ...item, selected: chosen.has(item.number), adding: adding.has(item.number), ...queueMarks(project, item) });
    return { project, projectError: projectInfo?.error, installed: dashboardStatus.status, refreshing: data.refreshing, error: data.error, errorCode: data.errorCode,
      loaded: data.loaded, refreshedAt: data.refreshedAt, account: data.account, waiting: data.waiting.map(decorate), progress: data.progress.map(decorate) };
  };
  // Other people's AI reviews of the patchset a Gerrit report reviewed, shown
  // under Publish. Read when the report is shown, at most once a minute.
  const otherAi = new Map();
  // Both checks hand back a read in progress, so an agent can wait for it.
  async function checkOtherAi(patch) {
    const saved = otherAi.get(patch.number);
    if (saved?.pending) return saved.pending;
    if (saved && Date.now() - saved.at < 60000) return;
    const pending = (async () => {
      let entry;
      try { entry = { at: Date.now(), reviews: aiReviews(await readTimeline(await findGerritCli(), patch.number, gerritCwd())) }; }
      catch (error) { entry = { at: Date.now() }; output.appendLine(`Gerrit comments for #${patch.number}: ${error.message}`); }
      if (disposed) return;
      otherAi.set(patch.number, entry);
      update();
    })();
    otherAi.set(patch.number, { ...saved, pending });
    return pending;
  }
  const signatureText = value => String(value || '').replace(/^\[|\]$/g, '').trim();
  const otherAiReviews = patch => {
    const reviews = otherAi.get(patch.number)?.reviews;
    if (!reviews) return undefined;
    // Leave out this extension's own publication; flag my account's others.
    const me = queue.get(patch.project).account, ours = registry.find(patch.project, patch.number, patch.patchset);
    return reviews.filter(review => review.patchset === patch.patchset)
      .filter(review => !(ours && (me ? review.author === me : review.signature === signatureText(ours.signature))))
      .map(({ author, signature, count, at }) => ({ author, signature, count, at, ...(me && author === me ? { mine: true } : {}) }));
  };
  // Reports & History: the Gerrit state of the change a report is about.
  // Read when the report is shown, at most once a minute: `gerrit info` for
  // the current patchset, CI and votes, and, once per pair of patchsets,
  // `gerrit diff` for the files a newer patchset changed.
  const changeInfo = new Map(), patchsetFiles = new Map(), localChangeIds = new Map(), reportChecks = new Map();
  async function checkReport(report) {
    const last = reportChecks.get(report.id);
    if (last?.pending) return last.pending;
    if (last && Date.now() - last.at < 60000) return;
    const pending = readReport(report);
    reportChecks.set(report.id, { pending });
    return pending;
  }
  async function readReport(report) {
    try {
      const run = service.runs.get(report.runId), cwd = run?.repo || gerritCwd();
      const binary = await findGerritCli();
      let number = report.gerritPatch?.number;
      const reviewed = report.gerritPatch?.patchset;
      if (!report.gerritPatch) {
        const sha = report.reportSha;
        if (!localChangeIds.has(sha)) localChangeIds.set(sha, (await commitInfo(cwd, sha)).changeId || null);
        const changeId = localChangeIds.get(sha);
        if (changeId && projectInfo?.project) {
          await links.check(projectInfo.project, baseBranch(), [{ sha, changeId }], cwd);
          number = links.view(projectInfo.project, { sha, changeId }).number;
        }
      }
      if (number) {
        const details = changeDetails(await readChange(binary, `${GERRIT_ORIGIN}/${number}`, cwd), number);
        if (details) changeInfo.set(number, details);
        const key = `${number}:${reviewed}:${details?.ps}`;
        if (reviewed && details?.ps > reviewed && !patchsetFiles.has(key)) patchsetFiles.set(key, await readPatchsetFiles(binary, number, reviewed, details.ps, cwd));
      }
    } catch (error) { output.appendLine(`Gerrit details for a report: ${error.message}`); }
    finally { reportChecks.set(report.id, { at: Date.now() }); if (!disposed) update(); }
  }
  const reportGerrit = report => {
    const account = projectInfo?.project ? queue.get(projectInfo.project).account : undefined;
    const mark = votes => (votes || []).map(vote => ({ ...vote, ...(account && vote.name === account ? { me: true } : {}) }));
    const ci = (item, details) => item && (!details || item.ps >= details.ps) ?
      { build: item.build, tests: item.tests, failedTests: item.failedTests, votes: item.votes, replyAt: item.replyAt } :
      details ? { build: details.build, tests: details.tests, votes: mark(details.votes) } : {};
    if (report.gerritPatch) {
      const patch = report.gerritPatch, details = changeInfo.get(patch.number);
      const item = projectInfo?.project === patch.project ? queueItems().find(entry => entry.number === patch.number) : undefined;
      const current = Math.max(details?.ps || 0, item?.ps || 0) || undefined;
      const changed = current > patch.patchset ? patchsetFiles.get(`${patch.number}:${patch.patchset}:${current}`) : undefined;
      return { kind: 'gerrit', number: patch.number, reviewed: patch.patchset, ...(current ? { current } : {}), ...(details ? { status: details.status } : {}),
        ...(details?.status === 'NEW' && details.mergeable === false ? { conflict: true } : {}),
        ...ci(item, details), ...(changed ? { changed } : {}), loading: !details && !item };
    }
    const sha = report.reportSha, changeId = localChangeIds.get(sha);
    if (changeId === undefined) return { kind: 'local', sha, link: { state: 'checking' } };
    const link = changeId ? links.view(projectInfo?.project, { sha, changeId }) : { state: 'none', reason: 'changeId' };
    const details = link.number ? changeInfo.get(link.number) : undefined;
    return { kind: 'local', sha, link, ...(details ? { current: details.ps, status: details.status, ...ci(undefined, details) } : {}) };
  };
  function refreshQueue(manual = false) {
    if (!projectInfo?.project) {
      if (manual) throw new Error(projectInfo?.error || t('Choose a Git repository with a Gerrit remote in Local commits.'));
      return;
    }
    void queue.refresh(projectInfo.project, selectedRepository.path);
  }
  // The first look at a project loads it; later refreshes are by hand.
  const loadQueue = () => {
    if (section !== 'gerritPatches' || patchesTab === 'url' || !projectInfo?.project) return;
    const data = queue.get(projectInfo.project);
    if (!data.loaded && !data.refreshing && !data.error) refreshQueue();
  };
  const reviewDiff = new ReviewDiff(vscode);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, reviewDiff), { dispose: () => reviewDiff.dispose() });
  // The Comments panel follows the review chosen on the open Reports & History tab.
  let commentsIdentity = '', commentsSequence = 0;
  async function openGerritConfig() {
    const file = await gerritConfigFile(gerritCwd());
    // A click creates only a missing CLI-owned file; never overwrite credentials.
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await fs.open(file, 'wx', 0o600);
      await handle.writeFile('# Gerrit CLI configuration. Existing environment variables take precedence.\n# Create an HTTP password in Gerrit: Settings > HTTP Credentials.\nGERRIT_URL=https://review.whamcloud.com\nGERRIT_USER=\nGERRIT_PASS=\n');
    } catch (e) { if (e.code !== 'EEXIST') throw new Error(t('Could not create the Gerrit CLI configuration file. Check its directory permissions.')); }
    finally { await handle?.close(); }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, { preview: false });
  }
  const connections = new AgentConnections(finders, () => {
    if (disposed) return;
    for (const entry of connections.all()) {
      const previous = connectionStates.get(entry.agent);
      if (previous !== undefined && previous !== entry.status) {
        service.modelCache.delete(entry.agent); accountLimits.invalidate();
      }
      connectionStates.set(entry.agent, entry.status);
    }
    // Wait for the saved agent's check before selecting an available alternative.
    if (!activeRun() && !starting && !['connected', 'checking'].includes(connections.get(agent).status)) {
      const next = connections.all().find(entry => entry.status === 'connected');
      if (next) {
        ++modelSequence; loadingModels = false;
        agent = next.agent; model = savedModel(); effort = savedEffort();
        void context.workspaceState.update('agent', agent);
      }
    }
    update(); refreshLimits();
  });
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  statusBar.name = 'Lustre Review Helper'; statusBar.command = 'lustreReview.status';
  context.subscriptions.push(statusBar); statusBar.show();
  const setStatsCleared = value => {
    const released = value && !statsCleared;
    statsCleared = value;
    void context.workspaceState.update('statsCleared', value);
    // Review let go of a finished batch: what failed in it can go now.
    if (released) void sweepHistory();
  };
  const checked = () => shown().filter(c => selected.has(c.sha)).map(c => c.sha);
  const activeRun = () => service.history().find(r => service.children.has(r.id) || ['running', 'cancelling'].includes(r.status));
  // A running batch cannot take more targets, and finishing it clears both lists.
  const editable = () => {
    if (starting || activeRun()) throw new Error(t('Wait for the current review to finish before changing what to review.'));
  };
  const draft = () => JSON.stringify([selectedRepository?.id, checked(), gerritPatches.get().items.map(p => [p.number,p.patchset]), agent, model?.id, effort, mode]);
  const accountLimits = new AccountLimits({
    codex: async options => readCodexLimits(await findCodex(), options),
    claude: async options => readClaudeLimits(await findClaude(), options),
  }, () => update());
  // History already carries usage. get() requires an open repository, and Git
  // discovery has not run yet; old history can also belong to a closed repo.
  for (const run of service.history()) accountLimits.seed(run.agent, run.usage?.limits);
  const refreshLimits = () => {
    if (!disposed && view && view.visible !== false && section === 'review' && connections.get(activeRun()?.agent || agent).status === 'connected') {
      void accountLimits.refresh(activeRun()?.agent || agent);
    }
  };
  const visibleReports = repository => [...service.runs.values()]
    .filter(run => (!repository || run.repository === repository) && !hiddenHistory.has(run.id) && service.repositories.some(repo => repo.id === run.repository))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).flatMap(patchReports);
  const wasRead = report => readReports.has(report.id) || readReports.has(report.runId);
  const hasReport = report => reportAvailability.get(report.id) === true;
  const runWasRead = run => {
    const available = patchReports(run).filter(hasReport);
    return readReports.has(run.id) || (available.length > 0 && available.every(wasRead));
  };
  const isNew = report => finished(report) && hasReport(report) && !wasRead(report) && !openingReports.has(report.runId);
  const unread = () => visibleReports().filter(isNew);
  async function indexReports(run) {
    if (indexingReports.has(run.id)) return indexingReports.get(run.id);
    const pending = (async () => {
      const reports = patchReports(run);
      const checks = await Promise.allSettled(reports.map(report => service.reportFiles(run.id, report.reportSha)));
      for (const [index, check] of checks.entries()) {
        reportAvailability.set(reports[index].id, check.status === 'fulfilled' && check.value.length > 0);
        if (check.status === 'rejected') output.appendLine(`Cannot read report ${reports[index].id}: ${check.reason.message}`);
      }
      await Promise.all(reports.filter(report => report.gerritPatch).map(report => publication.refresh(run.id, report.reportSha)));
      update();
    })();
    indexingReports.set(run.id, pending);
    try { await pending; } finally { indexingReports.delete(run.id); }
  }
  // One review in the Reports & History list: what its row, its filters and
  // its hover card show, without the review's findings and log.
  const FINDING_KEYS = ['defect', 'minor', 'suggestion', 'typo', 'style', 'nit', 'other'];
  const knownNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const historyRow = report => {
    const result = report.results?.[0], counts = findingCounts(report.results || [], 1) || {}, patch = report.gerritPatch;
    const row = { id: report.id, runId: report.runId, startedAt: report.startedAt, status: report.status, ...(result ? { result: result.status } : {}),
      subject: report.subjects?.[0]?.subject || '', tickets: report.tickets || [], hasReport: hasReport(report), isNew: isNew(report),
      agent: report.agent, model: report.modelName || report.model, effort: report.effort,
      kinds: Object.fromEntries(FINDING_KEYS.filter(key => counts[key] > 0).map(key => [key, counts[key]])),
      ...(knownNumber(result?.duration) ? { duration: result.duration } : {}), ...(knownNumber(result?.costUsd) ? { cost: result.costUsd } : {}) };
    if (patch) {
      const details = changeInfo.get(patch.number);
      const item = projectInfo?.project === patch.project ? queueItems().find(entry => entry.number === patch.number) : undefined;
      const current = Math.max(details?.ps || 0, item?.ps || 0) || undefined;
      const posted = publication.get(report.runId, report.reportSha).status === 'posted';
      const elsewhere = !posted && !!registry.find(patch.project, patch.number, patch.patchset);
      return { ...row, gerrit: { change: patch.number, ps: patch.patchset, project: patch.project, ...(patch.branch ? { branch: patch.branch } : {}),
        ...(current ? { current } : {}), published: posted, ...(elsewhere ? { publishedElsewhere: true } : {}) } };
    }
    const sha = report.reportSha, changeId = localChangeIds.get(sha) || undefined;
    const view = changeId && projectInfo?.project ? links.view(projectInfo.project, { sha, changeId }) : { state: 'none' };
    // For a commit Gerrit has as is: whether an AI review of that patchset is published.
    const published = view.state === 'current' && view.number && view.ps ? !!registry.find(projectInfo.project, view.number, view.ps) : undefined;
    return { ...row, local: { sha, ...(changeId ? { changeId } : {}), ...(branchMembers.shas.has(sha) ? { onBranch: branchMembers.shas.get(sha) } : {}),
      link: { state: view.state, ...(view.number ? { change: view.number } : {}), ...(view.ps ? { ps: view.ps } : {}) },
      ...(published !== undefined ? { published } : {}) } };
  };

  // Reports & History keeps only successful reviews of work still open. A
  // review that failed or was cancelled, and every review of a change that
  // landed or was abandoned, is deleted with its files, not hidden. A batch
  // shown on Review stays until Review lets it go.
  function onReview(run) { return run.id === currentReview && (!finished(run) || (!statsCleared && !runWasRead(run))); }
  // Local reviews on the current branch, for the Current branch filter: the
  // commit is on it, or is an older version of a commit on it (same Change-Id).
  let branchMembers = { head: undefined, shas: new Map() };
  async function updateBranchMembers() {
    if (!selectedRepository) return;
    const repo = selectedRepository, head = commits[0]?.sha;
    if (branchMembers.head !== head || branchMembers.repo !== repo.id) branchMembers = { head, repo: repo.id, shas: new Map() };
    const ids = new Set(commits.map(commit => commit.changeId).filter(Boolean));
    const local = [...new Set([...service.runs.values()].filter(run => run.repository === repo.id)
      .flatMap(run => run.commits.filter(key => /^[a-f0-9]{40,64}$/.test(key))))];
    for (const sha of local) {
      if (branchMembers.shas.has(sha)) continue;
      if (!localChangeIds.has(sha)) localChangeIds.set(sha, (await commitInfo(repo.path, sha).catch(() => ({}))).changeId || null);
      const changeId = localChangeIds.get(sha);
      branchMembers.shas.set(sha, !!head && ((changeId && ids.has(changeId)) || await git(repo.path, ['merge-base', '--is-ancestor', sha, head]).then(() => true, () => false)));
    }
  }
  function sweepHistory(options = {}) {
    sweepChain = sweepChain.then(() => sweep(options)).catch(e => output.appendLine(`Reports & History clean-up: ${e.message}`));
    return sweepChain;
  }
  async function sweep({ gerrit: readGerrit = false } = {}) {
    if (disposed) return;
    const runs = [...service.runs.values()].filter(run => finished(run) && !onReview(run) && service.repositories.some(repo => repo.id === run.repository));
    // Gerrit: one search an hour for the status of every reviewed change, and
    // the current patchset of the open ones, so that outdated reviews show.
    const numbers = [...new Set(runs.flatMap(run => (run.gerritPatches || []).map(patch => patch.number)))];
    if (readGerrit && numbers.length && Date.now() - lastGerritSweep >= 3600000) {
      lastGerritSweep = Date.now();
      try {
        const binary = await findGerritCli();
        for (let i = 0; i < numbers.length; i += 50) {
          for (const [number, status] of await searchChanges(binary, numbers.slice(i, i + 50), gerritCwd())) changeStatus.set(number, status);
        }
        const open = numbers.filter(number => changeStatus.get(number) === 'NEW' && Date.now() - (changeInfoAt.get(number) || 0) >= 3600000).slice(0, 30);
        for (const number of open) {
          const details = changeDetails(await readChange(binary, `${GERRIT_ORIGIN}/${number}`, gerritCwd()).catch(() => undefined), number);
          if (details) { changeInfo.set(number, details); changeInfoAt.set(number, Date.now()); }
        }
      } catch (e) { output.appendLine(`Gerrit status of reviewed changes: ${e.message}`); }
    }
    const statuses = new Map(numbers.map(number => [number, changeStatus.get(number) || changeInfo.get(number)?.status]));
    // Local commits: their link to Gerrit, and whether they landed on the base
    // branch. Git is asked at most every ten minutes per repository.
    const linkStates = new Map(), landed = new Set();
    for (const repo of service.repositories) {
      const local = [...new Set(runs.filter(run => run.repository === repo.id).flatMap(run => run.commits.filter(key => /^[a-f0-9]{40,64}$/.test(key))))];
      if (!local.length) continue;
      for (const sha of local) if (!localChangeIds.has(sha)) localChangeIds.set(sha, (await commitInfo(repo.path, sha).catch(() => ({}))).changeId || null);
      const last = localChecks.get(repo.id);
      if (!last || Date.now() - last.at >= 600000 || local.some(sha => !last.known.has(sha))) {
        const found = await landedCommits(repo.path, local.map(sha => ({ sha, changeId: localChangeIds.get(sha) || undefined })))
          .catch(() => ({ landed: new Set(), bases: new Map() }));
        localChecks.set(repo.id, { at: Date.now(), known: new Set(local), ...found });
      }
      const checked = localChecks.get(repo.id);
      for (const sha of checked.landed) landed.add(sha);
      // A change that landed or was abandoned counts only on the branch the
      // commit is based on: a backport keeps the Change-Id of a change landed elsewhere.
      const project = repo.id === selectedRepository?.id ? projectInfo?.project : undefined;
      if (project) for (const sha of local) {
        const changeId = localChangeIds.get(sha), view = changeId ? links.view(project, { sha, changeId }) : undefined;
        const base = checked.bases.get(sha), branch = base?.slice(base.indexOf('/') + 1);
        if (view && ['merged', 'abandoned'].includes(view.state) && branch && view.branch === branch) linkStates.set(sha, view.state);
      }
    }
    const drop = cleanupPlan({ runs, statuses, links: linkStates, landed });
    const removed = [];
    for (const [id, keys] of drop) {
      const run = service.runs.get(id);
      if (!run || onReview(run)) continue;
      const whole = run.commits.every(key => keys.has(key));
      // Named before the run forgets them.
      const names = new Map([...keys.keys()].map(key => { const patch = run.gerritPatches?.find(item => item.id === key); return [key, patch ? `#${patch.number} PS ${patch.patchset}` : key.slice(0, 7)]; }));
      if (!(await service.discard(id, [...keys.keys()]))) continue;
      for (const [key, why] of keys) output.appendLine(`Reports & History: deleted the review of ${names.get(key)} (${why}).`);
      if (whole) removed.push(id);
    }
    if (!drop.size) return;
    if (removed.length) {
      await registry.forget(removed).catch(e => output.appendLine(`Published reviews: ${e.message}`));
      for (const id of removed) { hiddenHistory.delete(id); for (const read of [...readReports]) if (read === id || read.startsWith(`${id}:`)) readReports.delete(read); }
      await context.workspaceState.update('hiddenHistory', [...hiddenHistory]);
      await context.workspaceState.update('readReports', [...readReports]);
    }
    const exists = id => visibleReports(selectedRepository?.id).some(report => report.id === id || report.runId === id);
    if (selectedRun && !exists(selectedRun)) selectedRun = undefined;
    if (selectedGerritRun && !exists(selectedGerritRun)) selectedGerritRun = undefined;
    update();
  }

  const state = () => {
    const entries = selectedRepository ? visibleReports(selectedRepository.id) : [];
    const local = entries.filter(r => !r.gerritPatch), online = entries.filter(r => r.gerritPatch);
    const current = selectedRun ? local.find(r => r.id === selectedRun) || local.find(r => r.runId === selectedRun) : undefined;
    const currentGerrit = selectedGerritRun ? online.find(r => r.id === selectedGerritRun) || online.find(r => r.runId === selectedGerritRun) : undefined;
    // The same patchset published by another review, in this window or another.
    const shared = report => {
      const entry = registry.find(report.gerritPatch.project, report.gerritPatch.number, report.gerritPatch.patchset);
      return entry && entry.run !== report.runId ? { postedAt: entry.postedAt, signature: entry.signature } : undefined;
    };
    const forView = source => { const { log, ...run } = source; return { ...run, summary: summarize(run), hasReport: hasReport(run), isNew: isNew(run), gerritState: reportGerrit(run),
      ...(run.gerritPatch ? { publication: publication.get(run.runId, run.reportSha), sharedPublication: shared(run), otherAiReviews: otherAiReviews(run.gerritPatch) } : {}) }; };
    const latest = service.runs.get(currentReview);
    const review = activeRun() || (latest?.repository === selectedRepository?.id ? latest : undefined);
    const logReview = review || (entries[0] && service.runs.get(entries[0].runId));
    return { type: 'state', repository: selectedRepository?.path, repositoryId: selectedRepository?.id, branch,
      section, commits: shown().map(c => ({ ...c, selected: selected.has(c.sha), merged: merged.has(c.sha), gerrit: links.view(projectInfo?.project, c) })),
      totalCommits: commits.length, mergedCount: commits.filter(c => merged.has(c.sha)).length, mergedBase, hideMerged,
      selectedCommits: shown().filter(c => selected.has(c.sha)), selected: checked().length, agent, model, effort, mode, notice, loadingModels,
      commitLimit: config().get('commitLimit', 30), autoOpenReports,
      usageStatistics: statistics.rows(),
      connections: connections.all().map(entry => ({ ...entry, pending: authActions.has(entry.agent) })),
      mcpSetup: Object.fromEntries(Object.keys(AGENTS).map(target => [target, { pending: mcpActions.has(target),
        ...mcpMessages.get(mcpKey(target)) }])),
      authBusy: authActions.size > 0, lreview: lreviewStatus, git: gitState, diffScope, unreadCount: unread().length,
      gerrit: gerrit.get(gerritCwd()), gerritBotName: config().get('gerritBotName', ''),
      gerritSignatureDetails: config().get('gerritSignatureDetails', false) === true,
      language: languageInfo(), gerritPatches: gerritPatches.get(), patchesTab, patchesLayout: patchesLayout(), queue: queueView(),
      queueFilters, queueDefaults: QUEUE_DEFAULTS, gerritDashboard: dashboardStatus,
      reviewLogId: logReview?.id,
      accountLimits: accountLimits.get(activeRun()?.agent || agent),
      busy: starting || !!activeRun(), activeId: activeRun()?.id,
      history: local.map(historyRow), gerritHistory: online.map(historyRow),
      gerritRun: currentGerrit ? forView(currentGerrit) : undefined, historyTab, settingsTab,
      canClearHistory: entries.some(finished), run: current ? forView(current) : undefined,
      statsRun: review && (!finished(review) || (!statsCleared && !runWasRead(review))) ? forView(review) : undefined };
  };
  const update = () => {
    if (disposed) return;
    const key = draft();
    if (draftKey !== undefined && draftKey !== key) { setStatsCleared(true); reviewError = false; }
    draftKey = key;
    const snapshot = state();
    if (snapshot.section === 'history' && snapshot.historyTab === 'gerrit' && snapshot.gerritRun?.gerritPatch) void checkOtherAi(snapshot.gerritRun.gerritPatch);
    const shownReport = snapshot.section === 'history' ? (snapshot.historyTab === 'gerrit' ? snapshot.gerritRun : snapshot.run) : undefined;
    if (shownReport && !['running', 'cancelling'].includes(shownReport.status)) void checkReport(shownReport);
    const run = snapshot.statsRun;
    const notifications = unread();
    const status = snapshot.busy ? 'running' : reviewError ? 'failed' : run?.status === 'completed' ? 'completed' :
      ['failed', 'interrupted'].includes(run?.status) ? 'failed' : notifications.length ? 'completed' : 'idle';
    const label = { running: t('Review in progress'), completed: t('Report ready'), failed: t('Review failed'), idle: t('Ready for review') }[status];
    statusBar.text = `${status === 'running' ? '$(search) ' : ''}$(check) Lustre Review Helper`;
    statusBar.color = { running: '#55aaff', completed: '#69b580', failed: '#ef7272', idle: '#a0a0a0' }[status];
    const notificationLabel = tn(notifications.length, '{n} new review result', '{n} new review results') + (notifications.length ? ':\n' + notifications.slice(0, 5).map(item =>
      `${new Date(item.startedAt).toLocaleString(translation.locale)} · ${reviewTitle(item)}`).join('\n') : '');
    statusBar.tooltip = notifications.length ? `${label}\n${notificationLabel}` : label; statusBar.accessibilityInformation = { label: `Lustre Review: ${label}` };
    void syncComments(snapshot);
    if (view) {
      // Some VS Code versions leave WebviewView activity behind on undefined.
      // A zero-valued badge replaces that activity and is not rendered.
      view.badge = { value: notifications.length, tooltip: notifications.length ? notificationLabel : '' };
      void view.webview.postMessage({ ...snapshot, reviewStatus: status, reviewStatusLabel: label });
    }
  };
  const error = e => { notice = e.message || String(e); output.appendLine(notice); update(); void vscode.window.showErrorMessage(notice); };
  const guarded = fn => (...args) => Promise.resolve().then(() => fn(...args)).catch(error);
  const command = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand(`lustreReview.${name}`, guarded(fn)));
  const saveSelection = () => context.workspaceState.update(`selected:${selectedRepository.id}`, [...selected]);

  async function setSection(value, focus = false, tab) {
    if (value === null) value = 'review';
    // Sent to settings for a reason: open the category that holds the fix.
    if (value === 'settings' && SETTINGS_TABS.includes(tab)) { settingsTab = tab; await context.workspaceState.update('settingsTab', tab); }
    if (value !== null && !sections.includes(value)) return;
    // A finished batch stays on Review until the user moves to another section;
    // its reports stay NEW in Reports & History.
    const current = service.runs.get(currentReview);
    if (section === 'review' && value !== 'review' && current && finished(current)) setStatsCleared(true);
    section = value;
    await context.workspaceState.update('section', section);
    if (focus) await vscode.commands.executeCommand('lustreReview.review.focus');
    update();
    refreshLimits();
    if (section === 'settings') { void connections.refreshAll(); void checkLreview(); void checkGit(); void checkDashboard(); refreshMcp(); }
    if (section === 'gerritPatches') { void checkDashboard(); loadQueue(); }
  }

  async function refresh() {
    if (disposed) return;
    const sequence = ++refreshSequence;
    const previous = selectedRepository?.id;
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    const gitApi = (await gitExtension.activate()).getAPI(1);
    const roots = [...gitApi.repositories.map(r => r.rootUri.fsPath),
      ...(vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath)];
    const resolved = await Promise.allSettled(roots.map(root => repositoryRoot(root)));
    if (disposed || sequence !== refreshSequence) return;
    service.setRepositories(resolved.filter(r => r.status === 'fulfilled').map(r => r.value));
    selectedRepository = service.repositories.find(r => r.id === previous) || service.repositories.find(r => r.id === context.workspaceState.get('repository')) || service.repositories[0];
    gerritPatches.setRepository(selectedRepository?.path, false);
    if (previous !== selectedRepository?.id) branch = '';
    const [next, nextBranch] = selectedRepository ? await Promise.all([
      service.commits(selectedRepository.id, config().get('commitLimit')),
      currentBranch(selectedRepository.path).catch(() => 'Branch unavailable'),
    ]) : [[], ''];
    if (disposed || sequence !== refreshSequence) return;
    const landed = selectedRepository && next.length ? await mergedCommits(selectedRepository.path, next).catch(() => ({ merged: new Set() })) : { merged: new Set() };
    if (disposed || sequence !== refreshSequence) return;
    const project = selectedRepository ? await repositoryProject(selectedRepository.path).then(value => ({ project: value }), e => ({ error: e.message })) : undefined;
    if (disposed || sequence !== refreshSequence) return;
    projectInfo = project;
    commits = next; mergedBase = landed.base; merged = landed.merged;
    branch = nextBranch;
    if (selectedRepository) {
      selected = new Set(context.workspaceState.get(`selected:${selectedRepository.id}`, shown().length ? [shown()[0].sha] : []));
      await context.workspaceState.update('repository', selectedRepository.id);
    } else selected.clear();
    await sweepHistory();
    await updateBranchMembers().catch(e => output.appendLine(`Reports & History: ${e.message}`));
    if (disposed || sequence !== refreshSequence) return;
    update();
    refreshMcp();
    loadQueue();
    checkLinks();
    for (const run of service.runs.values()) {
      if (finished(run) && !hiddenHistory.has(run.id) && service.repositories.some(repo => repo.id === run.repository)) void indexReports(run);
    }
  }

  async function chooseModel() {
    if (authActions.size) return;
    if (connections.get(agent).status !== 'connected') throw new Error(t('Connect an agent in AI Settings first.'));
    const selectedAgent = agent;
    const sequence = ++modelSequence;
    const label = agentLabel(agent);
    loadingModels = true; notice = t('Loading {agent} models…', { agent: label }); update();
    try {
      const models = await service.models(true, selectedAgent);
      if (sequence !== modelSequence) return;
      const chosen = await vscode.window.showQuickPick(models.map(m => ({ label: m.name,
        description: m.id, detail: m.description, model: m })), { title: `Lustre Review Helper · ${t('{agent} model', { agent: label })}`, placeHolder: t('Models reported by the installed {agent} client', { agent: label }) });
      if (sequence !== modelSequence) return;
      if (chosen) {
        model = chosen.model;
        if (!model.efforts.includes(effort)) effort = '';
        await context.workspaceState.update(`model:${selectedAgent}`, model);
        await context.workspaceState.update(`effort:${selectedAgent}`, effort);
      }
    } finally { if (sequence === modelSequence) { loadingModels = false; notice = ''; update(); } }
  }

  async function run() {
    if (authActions.size || starting || activeRun() || service.starting) return;
    // Acquire the UI lock before any asynchronous prerequisite check.
    starting = true; reviewError = false; notice = t('Preparing review…'); update();
    try {
      if (!selectedRepository) throw new Error(t('Choose a local Git repository in Local commits first.'));
      if (!checked().length && !gerritPatches.get().items.length) throw new Error(t('Select at least one local commit or add a Gerrit patch.'));
      if (gerritPatches.get().pending) throw new Error(t('Wait for the Gerrit patch details to finish loading.'));
      await checkLreview(true);
      if (!lreviewStatus.installed) { await setSection('settings', true, 'utilities'); throw new Error(t('Install lreview or set Lustre Review: Lreview Path in VS Code settings before reviewing.')); }
      if (connections.get(agent).status !== 'connected') { await setSection('settings', true, 'accounts'); throw new Error(t('Connect an agent in AI Settings first.')); }
      await setSection('review', true);
      if (!model) await chooseModel();
      if (!model) return;
      const review = await service.start({ repository: selectedRepository.id, commits: checked(),
        gerritPatches: gerritPatches.get().items, agent, model: model.id, effort, mode });
      showReview(review);
      notice = '';
    } catch (error) { reviewError = true; throw error; }
    finally { starting = false; update(); }
  }

  const snapshots = new Map();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('lustre-review', {
    provideTextDocumentContent: uri => snapshots.get(uri.toString()) || '',
  }), vscode.workspace.onDidCloseTextDocument(doc => snapshots.delete(doc.uri.toString())));
  async function showSnapshot(name, content, line = 1) {
    const uri = vscode.Uri.from({ scheme: 'lustre-review', path: `/${name}`, query: String(Date.now()) });
    snapshots.set(uri.toString(), content);
    const document = await vscode.workspace.openTextDocument(uri);
    const position = new vscode.Position(Math.max(0, Math.min(line - 1, document.lineCount - 1)), 0);
    await vscode.window.showTextDocument(document, { preview: true, selection: new vscode.Range(position, position) });
  }

  async function syncComments(snapshot) {
    const report = snapshot.historyTab === 'gerrit' ? snapshot.gerritRun : snapshot.run;
    const result = report?.results?.[0], run = report && service.runs.get(report.runId);
    const wanted = run && ['clean', 'findings'].includes(result?.status) && result.comments?.length && gitState.installed ?
      JSON.stringify([report.id, result.sha, result.comments.length, run.signature || '']) : '';
    if (wanted === commentsIdentity) return;
    commentsIdentity = wanted;
    const sequence = ++commentsSequence;
    if (!wanted) { reviewDiff.clear(); return; }
    try {
      await reviewDiff.show({ key: report.id, repo: run.repo, sha: result.sha, comments: result.comments,
        author: run.signature || '[AI review]' }, () => !disposed && sequence === commentsSequence);
    } catch (error) {
      if (sequence !== commentsSequence) return;
      reviewDiff.clear();
      output.appendLine(`Cannot show review comments: ${error.message}`);
    }
  }
  async function openReviewDiff(id, scope = diffScope, only) {
    const report = visibleReports(selectedRepository?.id).find(entry => entry.id === id);
    if (!report) throw new Error(t('Choose a review from Reports & History.'));
    const result = report.results?.[0];
    if (!['clean', 'findings'].includes(result?.status)) throw new Error(t('This review has no completed result to compare.'));
    await checkGit(true);
    if (!gitState.installed) throw new Error(gitState.status === 'outdated' ? t('Update Git to {version} or newer to open review diffs.', { version: gitState.minimum }) : t('Install Git to open review diffs.'));
    const run = service.runs.get(report.runId);
    const subject = report.subjects?.[0]?.subject || result.subject || result.sha.slice(0, 12);
    // Unresolved discussions of the reviewed patchset, for this diff only.
    const patch = report.gerritPatch;
    const discussions = patch ? findGerritCli().then(binary => readComments(binary, patch.number, run.repo))
      .then(data => forPatchset(data, patch.patchset, result.comments || []))
      .catch(error => { output.appendLine(`Gerrit comments for #${patch.number}: ${error.message}`); return null; }) : undefined;
    await reviewDiff.open({ key: report.id, repo: run.repo, sha: result.sha, comments: result.comments || [], discussions,
      author: run.signature || '[AI review]', scope: ['commented', 'all'].includes(scope) ? scope : diffScope, ...(only ? { only } : {}),
      title: `${t('Review')} · ${subject}${report.gerritPatch ? ` · PS ${report.gerritPatch.patchset}` : ''}` });
  }

  const connectionFile = path.join(storage, 'connection.json');
  const runtime = path.join(context.globalStorageUri.fsPath, 'mcp-runtime');
  await fs.mkdir(runtime, { recursive: true });
  for (const file of ['mcp.js', 'bridge.js']) await fs.copyFile(path.join(context.extensionPath, 'src', file), path.join(runtime, file));
  // The review chosen on the open Reports & History tab, for agents.
  const selectedReport = () => {
    if (!selectedRepository) return undefined;
    const entries = visibleReports(selectedRepository.id).filter(report => !!report.gerritPatch === (historyTab === 'gerrit'));
    const chosen = historyTab === 'gerrit' ? selectedGerritRun : selectedRun;
    return chosen ? entries.find(report => report.id === chosen) || entries.find(report => report.runId === chosen) : undefined;
  };
  // What agents read beyond the review service: the Gerrit state the panels
  // show, for the repository an agent names.
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function agentProject(repositoryId) {
    const repo = service.repository(repositoryId);
    if (repo.id === selectedRepository?.id && projectInfo) {
      if (projectInfo.project) return { repo, project: projectInfo.project };
      throw new Error(projectInfo.error || 'This repository has no Gerrit project.');
    }
    return { repo, project: await repositoryProject(repo.path) };
  }
  const changeUrl = (project, number) => `${GERRIT_ORIGIN}/c/${project}/+/${number}`;
  const agentVotes = votes => (votes || []).map(({ name, value, me }) => ({ name, value, ...(me ? { me: true } : {}) }));
  const agentCi = live => ({ ...(live.build ? { build: live.build } : {}), ...(live.tests ? { tests: live.tests } : {}),
    ...(live.failedTests?.length ? { failed_tests: live.failedTests } : {}), ...(live.votes ? { votes: agentVotes(live.votes) } : {}) });
  const agentLink = (project, view) => ({ link: view.state, ...(view.reason ? { reason: { changeId: 'no Change-Id', missing: 'not on Gerrit', project: 'no Gerrit project' }[view.reason] || view.reason } : {}),
    ...(view.number ? { change: view.number, url: changeUrl(project, view.number) } : {}), ...(view.ps ? { patchset: view.ps } : {}),
    ...(view.branch ? { branch: view.branch } : {}), ...(view.conflict ? { merge_conflict: true } : {}) });
  // The report of one reviewed commit or patch of a run.
  const reportOf = (run, sha) => run ? patchReports(run).find(report => report.results?.[0]?.sha === sha) : undefined;
  // A report's Gerrit state, as General information shows it. Waits for a
  // read in progress (at most 20 s), else gives what is known.
  async function agentReportState(report) {
    if (!report || !report.results?.[0] || !['clean', 'findings'].includes(report.results[0].status)) return undefined;
    await Promise.race([Promise.all([checkReport(report), report.gerritPatch ? checkOtherAi(report.gerritPatch) : undefined]), pause(20000)]).catch(() => {});
    const live = reportGerrit(report), result = report.results[0];
    if (live.kind === 'gerrit') {
      // Outdated as General information shows it: a newer patchset touches a file with findings.
      const message = file => ['/COMMIT_MSG', 'COMMIT_MSG', 'COMMIT_MESSAGE'].includes(file) ? '/COMMIT_MSG' : file;
      const patch = report.gerritPatch, files = new Set((result.comments || []).map(comment => message(comment.file)));
      const changed = live.changed || [], touched = changed.filter(file => files.has(message(file)));
      const newer = live.current > live.reviewed, others = otherAiReviews(patch);
      return { change: live.number, url: changeUrl(patch.project, live.number), reviewed_patchset: live.reviewed,
        ...(live.current ? { current_patchset: live.current } : {}), ...(live.status ? { status: live.status } : {}), newer_patchset: newer,
        ...(newer && live.changed ? { files_changed_since_review: changed, findings_may_be_outdated: touched.length > 0 } : {}),
        ...(live.conflict ? { merge_conflict: true } : {}), ...agentCi(live), ...(live.replyAt ? { owner_replied_at: live.replyAt } : {}),
        published: publication.get(report.runId, report.reportSha).status === 'posted',
        ...(others ? { other_ai_reviews: others } : {}), ...(live.loading ? { note: 'Gerrit did not answer in time; ask again shortly.' } : {}) };
    }
    if (live.link.state === 'checking') return { link: 'checking', note: 'Gerrit did not answer in time; ask again shortly.' };
    return { ...agentLink(projectInfo?.project, live.link), ...(live.current ? { current_patchset: live.current } : {}),
      ...(live.status ? { status: live.status } : {}), ...agentCi(live) };
  }
  const QUEUE_STATE = { newps: 'new_patchset', replied: 'owner_replied', author: 'waiting_for_author', mine: 'my_plus_one' };
  const agentQueueItem = (project, item) => {
    const marks = queueMarks(project, item);
    return { change: item.number, patchset: item.ps, subject: item.subject, owner: item.owner, branch: item.branch, url: changeUrl(project, item.number),
      ...(item.kind !== 'waiting' ? { state: QUEUE_STATE[item.kind], my_patchset: item.myPs } : {}), ...(item.myVote ? { my_vote: item.myVote } : {}),
      ci: item.ci, ...agentCi(item), unresolved_comments: item.unresolved, ready_for_landing: item.ready,
      ...(item.replyAt ? { owner_replied_at: item.replyAt } : {}), ...(item.updated ? { updated_at: item.updated } : {}),
      ...(marks.published ? { ai_review: 'published', ai_review_published_at: marks.published.postedAt } : {}),
      ...(marks.aiReady ? { ai_review: marks.aiReady.here ? 'ready in this window, not published' : 'ready in another VS Code window, not published' } : {}),
      ...(item.aiOthers?.length ? { other_ai_reviews: item.aiOthers.map(({ author, signature, count, at }) => ({ author, signature, count, at })) } : {}) };
  };
  const bridge = await startBridge(service, connectionFile, {
    findReviews: async args => {
      const found = await findReviews(service, args);
      // The newest match of each commit or change carries its Gerrit state.
      const newest = [...(found.commits || []).map(commit => commit.reviews[0]), found.reviews?.[0]].filter(Boolean);
      await Promise.all(newest.map(async entry => {
        const state = await agentReportState(reportOf(service.runs.get(entry.review), entry.reviewed_commit)).catch(() => undefined);
        if (state) entry.gerrit_state = state;
      }));
      return found;
    },
    selectedReview: async () => {
      const report = selectedReport();
      if (!report) return null;
      const state = await agentReportState(report).catch(() => undefined);
      return reviewDetails(service, service.runs.get(report.runId), report, { tab: historyTab,
        ...(report.gerritPatch ? { published: publication.get(report.runId, report.reportSha).status === 'posted' } : {}),
        ...(state ? { gerrit_state: state } : {}) });
    },
    reviewReports: async id => {
      const run = service.runs.get(id);
      if (!run || !finished(run)) return {};
      const reports = await Promise.all(patchReports(run).filter(report => report.results?.[0]).map(async report => {
        const state = await agentReportState(report).catch(() => undefined);
        return { commit: report.reportSha, ...(report.gerritPatch ? { gerrit: { change: report.gerritPatch.number, patchset: report.gerritPatch.patchset } } : {}),
          status: report.results[0].status, ...(state ? { gerrit_state: state } : {}) };
      }));
      return reports.length ? { reports } : {};
    },
    commitLinks: async (repositoryId, commits) => {
      let target;
      try { target = await agentProject(repositoryId); } catch { return commits; }
      const { repo, project } = target;
      // Fresh links, as Local commits shows them; a slow Gerrit leaves the last known ones.
      await Promise.race([links.check(project, repo.id === selectedRepository?.id ? baseBranch() : undefined, commits, repo.path), pause(15000)]).catch(() => {});
      return commits.map(commit => commit.changeId ? { ...commit, gerrit: agentLink(project, links.view(project, commit)) } : commit);
    },
    gerritQueue: async ({ repository, refresh = false } = {}) => {
      const { repo, project } = await agentProject(repository);
      if (refresh || !queue.get(project).loaded) await queue.refresh(project, repo.path);
      const data = queue.get(project);
      if (!data.loaded) throw new Error(data.error || 'The Gerrit queue could not be read. Check gerrit-dashboard in AI Settings > Utilities.');
      return { repository: repo.id, project, refreshed_at: data.refreshedAt, ...(data.account ? { account: data.account } : {}),
        ...(data.error ? { refresh_error: data.error } : {}),
        waiting_review: data.waiting.map(item => agentQueueItem(project, item)), in_progress: data.progress.map(item => agentQueueItem(project, item)) };
    },
  }, { version: require(path.join(context.extensionPath, 'package.json')).version });
  async function refreshMcpTarget(target, force = false) {
    if (disposed || !selectedRepository || mcpActions.has(target)) return;
    const repository = selectedRepository, key = mcpKey(target, repository);
    const previous = mcpChecks.get(key);
    if (!force && (previous?.pending || Date.now() - (previous?.checkedAt || 0) < 30000)) return;
    previous?.controller.abort();
    const check = { controller: new AbortController(), pending: true };
    mcpChecks.set(key, check);
    // Preserve the last verified state while checking again in the background.
    if (!mcpMessages.has(key)) mcpMessages.set(key, { status: 'checking', message: t('Checking saved MCP settings…') });
    update();
    try {
      const status = await checkMcp({ agent: target, binary: target === 'codex' ? await finders[target]() : undefined,
        repository: repository.path, runtime, connectionFile, signal: check.controller.signal });
      if (!disposed && mcpChecks.get(key) === check && !mcpActions.has(target)) mcpMessages.set(key, status);
    } catch {
      if (!disposed && mcpChecks.get(key) === check) mcpMessages.set(key, { status: 'unknown', message: t('Could not check saved MCP settings. Refresh connections to retry.') });
    } finally {
      if (mcpChecks.get(key) === check) { check.pending = false; check.checkedAt = Date.now(); update(); }
    }
  }
  function refreshMcp(force = false) {
    for (const target of Object.keys(AGENTS)) void refreshMcpTarget(target, force);
  }
  async function mcpConfig() {
    const text = `# Add this block to ~/.codex/config.toml, then start a new Codex chat.\n` +
      `# Keep this trusted VS Code workspace open. No API key is stored here.\n` +
      `[mcp_servers.lreview_vscode]\ncommand = ${JSON.stringify(process.execPath)}\n` +
      `args = ${JSON.stringify([path.join(runtime, 'mcp.js'), '--connection', connectionFile])}\n` +
      `tool_timeout_sec = 60\n\n[mcp_servers.lreview_vscode.env]\nELECTRON_RUN_AS_NODE = "1"\n`;
    const document = await vscode.workspace.openTextDocument({ content: text, language: 'toml' });
    await vscode.window.showTextDocument(document);
  }
  async function setupMcp(target) {
    if (!Object.hasOwn(AGENTS, target) || mcpActions.has(target)) return;
    if (starting || activeRun()) throw new Error(t('Wait for the current review before connecting self-review.'));
    if (!selectedRepository) throw new Error(t('Open a Git repository before connecting self-review.'));
    const repository = selectedRepository;
    const key = mcpKey(target, repository);
    mcpChecks.get(key)?.controller.abort(); mcpChecks.delete(key);
    mcpActions.add(target); mcpMessages.delete(key); update();
    try {
      await connectMcp({ agent: target, binary: await finders[target](), repository: repository.path, runtime, connectionFile });
      mcpMessages.set(key, { status: 'configured', configured: true, message: t('Configured. Start a new agent chat and keep this VS Code window open.') });
      mcpChecks.set(key, { controller: new AbortController(), pending: false, checkedAt: Date.now() });
    } catch (error) { mcpMessages.set(key, { configured: false, message: error.message }); throw error; }
    finally { mcpActions.delete(target); update(); }
  }

  function showLogs() {
    const id = state().reviewLogId;
    const run = id ? service.get(id) : undefined;
    logRun = run?.id;
    output.clear(); output.append(run ? service.get(run.id).log : 'No review selected.'); output.show();
  }
  async function markRead(ids) {
    for (const id of ids) readReports.add(id);
    await context.workspaceState.update('readReports', [...readReports]);
    const current = service.runs.get(currentReview);
    if (current && finished(current) && runWasRead(current)) setStatsCleared(true);
    update();
  }
  async function clearHistory() {
    if (!selectedRepository) return;
    const ids = [...service.runs.values()].filter(run => run.repository === selectedRepository.id && finished(run)).map(run => run.id);
    for (const id of ids) hiddenHistory.add(id);
    await context.workspaceState.update('hiddenHistory', [...hiddenHistory]);
    await registry.forget(ids).catch(error => output.appendLine(`Published reviews: ${error.message}`));
    selectedRun = undefined; selectedGerritRun = undefined;
    await markRead(ids);
  }
  async function resetStatistics() {
    if (starting || activeRun()) throw new Error(t('Wait for the current review to finish before resetting statistics.'));
    await statistics.reset();
    update();
  }
  async function openReports(id = state().run?.id, manual = true) {
    if (disposed) return;
    if (!id) throw new Error(t('Choose a report from Reports & History.'));
    const reports = visibleReports().filter(report => manual ? report.id === id : report.runId === id);
    if (manual && !reports.length) throw new Error(t('Choose a report from Reports & History.'));
    let opened = 0;
    const failures = [];
    for (const report of reports) {
      try {
        const files = await service.reportFiles(report.runId, report.reportSha);
        reportAvailability.set(report.id, files.length > 0);
        if (manual && !files.length) throw new Error(t('No Markdown report is available for this review. Inspect its history and log.'));
        for (const file of files) {
          if (disposed) return;
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
          if (disposed) return;
          await vscode.window.showTextDocument(document, { preview: false, preserveFocus: opened > 0 });
          ++opened;
        }
        // Acknowledge only reports that the editor actually opened, including
        // automatic tabs. A failed tab must remain discoverable as NEW.
        if (files.length) await markRead([report.id]);
      } catch (error) { failures.push(error.message); }
    }
    update();
    if (failures.length) throw new Error(failures.join('\n'));
  }
  // A finished patch in the Review list: its report in Reports & History, or the
  // log when its review failed.
  async function openBatchReport(key) {
    const run = service.runs.get(currentReview);
    if (!run || typeof key !== 'string' || !run.commits?.includes(key)) return;
    const result = run.results?.find(item => resultKey(item) === key);
    if (!result) return;
    if (!['clean', 'findings'].includes(result.status)) { showLogs(); return; }
    const id = run.commits.length === 1 ? run.id : `${run.id}:${key}`;
    const report = visibleReports(run.repository).find(entry => entry.id === id);
    if (!report) return;
    if (report.gerritPatch) { selectedGerritRun = report.id; historyTab = 'gerrit'; } else { selectedRun = report.id; historyTab = 'local'; }
    await setSection('history');
  }
  // The unpublished AI review of a change's current patchset: in this window
  // it opens in Reports & History; another window has to publish its own.
  async function openAiReview(number) {
    const item = queueItems().find(entry => entry.number === number), project = projectInfo?.project;
    if (!item || !project) return;
    const ready = registry.ready(project, item.number, item.ps).filter(entry => !hiddenHistory.has(entry.run));
    const report = visibleReports(selectedRepository?.id).find(entry => entry.gerritPatch?.number === item.number &&
      entry.gerritPatch.patchset === item.ps && ready.some(saved => saved.run === entry.runId));
    if (report) { selectedGerritRun = report.id; historyTab = 'gerrit'; await setSection('history'); return; }
    const other = ready.find(entry => !service.runs.has(entry.run)) || ready[0];
    if (!other) { update(); throw new Error(t('No unpublished AI review of PS {ps} for change #{number} is available.', { ps: item.ps, number: item.number })); }
    const action = other.folder && other.folder !== selectedRepository?.path ? t('Open folder') : undefined;
    const choice = await vscode.window.showInformationMessage(other.folder ?
      t('The AI review of PS {ps} for change #{number} is in another VS Code window ({folder}). Publish it from that window.', { ps: item.ps, number: item.number, folder: other.folder }) :
      t('The AI review of PS {ps} for change #{number} is in another VS Code window. Publish it from that window.', { ps: item.ps, number: item.number }), ...(action ? [action] : []));
    if (choice === action && action) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(other.folder), { forceNewWindow: true });
  }
  async function publishGerrit(id) {
    const report = visibleReports(selectedRepository?.id).find(report => report.id === id && report.gerritPatch);
    if (!report) throw new Error(t('Choose a Gerrit report from Reports & History.'));
    // One AI review per patchset: read what other windows published just now.
    await registry.refresh();
    const patch = report.gerritPatch, earlier = registry.find(patch.project, patch.number, patch.patchset);
    if (earlier && earlier.run !== report.runId) {
      update();
      const values = { ps: patch.patchset, number: patch.number, date: new Date(earlier.postedAt).toLocaleString(translation.locale), signature: earlier.signature };
      throw new Error(earlier.signature ? t('PS {ps} of change #{number} was already published {date} by another review as {signature}. A patchset gets one AI review.', values) :
        t('PS {ps} of change #{number} was already published {date} by another review. A patchset gets one AI review.', values));
    }
    await publication.publish(report.runId, report.reportSha);
    await registry.record(service.runs.get(report.runId)).catch(error => output.appendLine(`Published reviews: ${error.message}`));
    await queue.markReviewed(patch.project, patch.number, patch.patchset).catch(error => output.appendLine(`Gerrit reviews: ${error.message}`));
    notice = ''; update();
  }
  async function authenticate(target, action) {
    if (!Object.hasOwn(AGENTS, target) || !['login', 'logout'].includes(action) || authActions.has(target)) return;
    if (starting || activeRun()) throw new Error(t('Wait for the current review before changing agent accounts.'));
    if (action === 'login' && loginTerminals.has(target)) { loginTerminals.get(target).show(); return; }
    authActions.add(target); update();
    try {
      notice = '';
      if (action === 'logout') {
        await connections.logout(target);
        if (connections.get(target).status === 'connected') notice = t('{agent} still reports an authenticated account. Check credentials supplied by your environment or managed configuration.', { agent: AGENTS[target].name });
      }
      else {
        const terminal = vscode.window.createTerminal({ name: t('{agent} sign in', { agent: AGENTS[target].name }),
          shellPath: await finders[target](), shellArgs: AGENTS[target].login,
          env: { AUGMENT_DISABLE_AUTO_UPDATE: '1' } });
        loginTerminals.set(target, terminal);
        context.subscriptions.push(terminal); terminal.show();
      }
    } finally {
      authActions.delete(target); service.modelCache.delete(target);
      accountLimits.invalidate(); update(); refreshLimits();
    }
  }

  command('refresh', refresh);
  command('repository', async () => {
    editable();
    await refresh();
    const pick = await vscode.window.showQuickPick(service.repositories.map(r => ({ label: r.name, description: r.path, repo: r })));
    if (pick) { editable(); selectedRepository = pick.repo; selectedRun = undefined; await refresh(); }
  });
  command('selectAll', async () => { editable(); if (selectedRepository) { selected = new Set(shown().map(c => c.sha)); await saveSelection(); update(); } });
  command('toggleMerged', async () => {
    editable();
    hideMerged = !hideMerged;
    await context.workspaceState.update('hideMerged', hideMerged);
    // Only visible commits can be selected: hiding merged ones deselects them.
    if (hideMerged && selectedRepository && [...selected].some(sha => merged.has(sha))) {
      selected = new Set([...selected].filter(sha => !merged.has(sha))); await saveSelection();
    }
    update();
    checkLinks();
  });
  command('clearSelection', async () => { editable(); if (selectedRepository) { selected.clear(); await saveSelection(); update(); } });
  command('model', chooseModel);
  command('run', run);
  command('mcpConfig', mcpConfig);
  for (const target of Object.keys(AGENTS)) command(`connect${target[0].toUpperCase()}${target.slice(1)}`, () => setupMcp(target));
  command('logs', showLogs);
  command('settings', () => setSection('settings', true));
  // The version left of the gear in the view's title opens what changed in it.
  command('version', () => vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.joinPath(context.extensionUri, 'CHANGELOG.md')));
  command('status', async () => {
    const next = unread()[0];
    if (next && !activeRun()) {
      selectedRepository = service.repositories.find(repo => repo.id === next.repository);
      if (next.gerritPatch) { selectedGerritRun = next.id; historyTab = 'gerrit'; } else { selectedRun = next.id; historyTab = 'local'; }
      await refresh();
      await setSection('history', true);
    } else await setSection('review', true);
  });
  command('reports', () => openReports());
  command('augmentSetup', () => setSection('settings', true, 'accounts'));
  // A commit in Local commits opens in the diff editor Reports & History uses.
  command('showCommit', async sha => {
    const commit = commits.find(c => c.sha === sha);
    if (!commit) throw new Error(t('Unknown commit.'));
    await reviewDiff.openCommit({ repo: selectedRepository.path, sha, title: `${t('Commit {sha}', { sha: commit.shortSha })} · ${commit.subject}` });
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('lustreReview.review', {
    resolveWebviewView(webviewView) {
      view = webviewView;
      view.onDidDispose?.(() => { if (view === webviewView) view = undefined; });
      view.onDidChangeVisibility?.(refreshLimits);
      view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] };
      view.webview.html = reviewHtml(view.webview, vscode, context.extensionUri, translation, languageInfo());
      context.subscriptions.push(view.webview.onDidReceiveMessage(guarded(async message => {
        switch (message?.type) {
          case 'ready': update(); refreshLimits(); void connections.refreshAll(); void checkLreview(); void checkGit(); void checkDashboard(); refreshMcp(); loadQueue(); break;
          case 'limits': refreshLimits(); break;
          case 'section': await setSection(message.value); break;
          case 'selection':
            if (message.repository !== selectedRepository?.id || typeof message.checked !== 'boolean' || !shown().some(c => c.sha === message.sha)) break;
            // Resend state so a checkbox clicked during a review shows the kept selection.
            if (starting || activeRun()) { update(); break; }
            if (message.checked) selected.add(message.sha); else selected.delete(message.sha);
            await saveSelection(); update();
            break;
          case 'refresh': case 'repository': case 'selectAll': case 'clearSelection': case 'toggleMerged':
            await vscode.commands.executeCommand(`lustreReview.${message.type}`); break;
          case 'showCommit':
            if (message.repository === selectedRepository?.id) await vscode.commands.executeCommand('lustreReview.showCommit', message.sha);
            break;
          case 'model': await chooseModel(); break;
          case 'agent':
            if (!activeRun() && !starting && connections.get(message.value).status === 'connected' && message.value !== agent) {
              ++modelSequence; loadingModels = false; notice = '';
              agent = message.value; model = savedModel(); effort = savedEffort();
              await context.workspaceState.update('agent', agent); update();
              refreshLimits();
              if (!model) await chooseModel();
            }
            break;
          case 'run': await run(); break;
          case 'cancel': if (activeRun()) await service.cancel(activeRun().id); break;
          case 'mcp': await mcpConfig(); break;
          case 'connectMcp': await setupMcp(message.agent); break;
          case 'logs': showLogs(); break;
          case 'reports': await openReports(); break;
          case 'openBatchReport': await openBatchReport(message.key); break;
          case 'gerritReports': await openReports(message.id || state().gerritRun?.id); break;
          case 'publishGerrit': await publishGerrit(message.id); break;
          case 'autoOpenReports':
            if (typeof message.value === 'boolean') {
              autoOpenReports = message.value;
              await context.workspaceState.update('autoOpenReports', autoOpenReports); update();
            }
            break;
          case 'clearHistory': await clearHistory(); break;
          case 'resetStatistics': await resetStatistics(); break;
          case 'clearNotifications': await markRead(unread().map(run => run.id)); break;
          case 'lreviewDownload': case 'lreviewHelp': await vscode.env.openExternal(vscode.Uri.parse(LREVIEW_URL)); break;
          case 'gitDownload': case 'gitHelp': await vscode.env.openExternal(vscode.Uri.parse(GIT_URL)); break;
          case 'reviewDiff': await openReviewDiff(message.id, message.scope); break;
          case 'reviewDiffFile': {
            // Only a file the review commented on, never a path from the view.
            const report = visibleReports(selectedRepository?.id).find(entry => entry.id === message.id);
            const files = new Set((report?.results?.[0]?.comments || []).map(comment => ['/COMMIT_MSG', 'COMMIT_MSG', 'COMMIT_MESSAGE'].includes(comment.file) ? '/COMMIT_MSG' : comment.file));
            if (typeof message.file === 'string' && files.has(message.file)) await openReviewDiff(message.id, 'commented', message.file);
            break;
          }
          case 'openReportChange': {
            const report = visibleReports(selectedRepository?.id).find(entry => entry.id === message.id);
            const state = report && reportGerrit(report);
            const number = state?.kind === 'gerrit' ? state.number : state?.link?.number;
            const project = report?.gerritPatch?.project || projectInfo?.project;
            if (number && project) await vscode.env.openExternal(vscode.Uri.parse(`${GERRIT_ORIGIN}/c/${project}/+/${number}`));
            break;
          }
          case 'diffScope':
            if (['commented', 'all'].includes(message.value)) { diffScope = message.value; await context.workspaceState.update('diffScope', diffScope); update(); }
            break;
          case 'gerritHelp': await vscode.env.openExternal(vscode.Uri.parse(GERRIT_URL)); break;
          case 'gerritConfig': await openGerritConfig(); break;
          case 'gerritCheck': await gerrit.refresh(gerritCwd()); break;
          case 'addGerritPatch': editable(); await gerritPatches.add(message.url); break;
          case 'patchesTab':
            if (PATCHES_TABS.includes(message.value)) {
              patchesTab = message.value; await context.workspaceState.update('patchesTab', patchesTab); update(); loadQueue();
            }
            break;
          case 'refreshQueue': refreshQueue(true); break;
          case 'queueFilters':
            if (Object.hasOwn(QUEUE_FILTERS, message.tab) && Array.isArray(message.hidden) && message.hidden.every(key => QUEUE_FILTERS[message.tab].includes(key))) {
              queueFilters = queueFilterState({ ...queueFilters, [message.tab]: message.hidden });
              await context.workspaceState.update('queueFilters', queueFilters); update();
            }
            break;
          case 'queueSelect': {
            const item = queueItems().find(entry => entry.number === message.number);
            if (!item || typeof message.checked !== 'boolean') break;
            // Resend state so a checkbox clicked during a review shows the kept selection.
            if (starting || activeRun()) { update(); break; }
            if (!message.checked) { await gerritPatches.remove(item.number); break; }
            if (registry.find(projectInfo.project, item.number, item.ps)) { update(); throw new Error(t('PS {ps} of change #{number} already has a published AI review. A patchset gets one AI review.', { ps: item.ps, number: item.number })); }
            await gerritPatches.addChange(item.number);
            break;
          }
          case 'openCommitChange': {
            const commit = message.repository === selectedRepository?.id ? shown().find(entry => entry.sha === message.sha) : undefined;
            const link = commit && links.view(projectInfo?.project, commit);
            if (link?.number) await vscode.env.openExternal(vscode.Uri.parse(`${GERRIT_ORIGIN}/c/${projectInfo.project}/+/${link.number}`));
            break;
          }
          case 'openChange': {
            const item = queueItems().find(entry => entry.number === message.number);
            if (item && projectInfo?.project) await vscode.env.openExternal(vscode.Uri.parse(`${GERRIT_ORIGIN}/c/${projectInfo.project}/+/${item.number}`));
            break;
          }
          case 'openAiReview': await openAiReview(message.number); break;
          case 'openUtilities': await setSection('settings', false, 'utilities'); break;
          case 'openSettings': if (SETTINGS_TABS.includes(message.tab)) await setSection('settings', false, message.tab); break;
          // Automatic clears the setting, so that a new VS Code language applies.
          case 'language':
            if (message.value === 'auto' || LANGUAGE_IDS.includes(message.value)) {
              await config().update('language', message.value === 'auto' ? undefined : message.value, vscode.ConfigurationTarget.Global);
            }
            break;
          // From a Gerrit problem shown in Gerrit patches: Utilities, checking the login now.
          case 'checkGerrit': await setSection('settings', false, 'utilities'); void gerrit.refresh(gerritCwd()); break;
          case 'patchesLayout':
            if (LAYOUTS.includes(message.value)) { await config().update('gerritPatchesLayout', message.value, vscode.ConfigurationTarget.Global); update(); }
            break;
          case 'dashboardHelp': case 'dashboardDownload': await vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL)); break;
          case 'removeGerritPatch': editable(); await gerritPatches.remove(message.number); break;
          case 'gerritBotName': {
            const name = botName(message.value);
            await config().update('gerritBotName', name, vscode.ConfigurationTarget.Global);
            notice = ''; update(); break;
          }
          case 'gerritSignatureDetails':
            if (typeof message.value === 'boolean') {
              await config().update('gerritSignatureDetails', message.value, vscode.ConfigurationTarget.Global);
              notice = ''; update();
            }
            break;
          case 'authenticate': await authenticate(message.agent, message.action); break;
          case 'agentHelp': if (Object.hasOwn(AGENTS, message.agent)) await vscode.env.openExternal(vscode.Uri.parse(AGENTS[message.agent].url)); break;
          case 'connections': void connections.refreshAll(true); void checkLreview(true); void checkGit(true); void checkDashboard(true); void gerrit.refresh(gerritCwd()); refreshMcp(true); break;
          case 'commitLimit': {
            if (!Number.isInteger(message.value) || message.value < 1 || message.value > 200) {
              throw new Error(t('Commits to display must be a whole number from 1 to 200.'));
            }
            const settings = config();
            // Keep an existing workspace override; otherwise save this UI preference for all projects.
            const target = settings.inspect('commitLimit')?.workspaceValue !== undefined ?
              vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
            await settings.update('commitLimit', message.value, target);
            notice = '';
            await refresh();
            break;
          }
          case 'mode': if (['full', 'light'].includes(message.value)) { mode = message.value; await context.workspaceState.update('mode', mode); update(); } break;
          case 'effort': if (message.value === '' || model?.efforts.includes(message.value)) { effort = message.value; await context.workspaceState.update(`effort:${agent}`, effort); update(); } break;
          case 'history': if (visibleReports(selectedRepository?.id).some(r => r.id === message.id && !r.gerritPatch)) { selectedRun = message.id; historyTab = 'local'; update(); } break;
          case 'gerritHistory': if (visibleReports(selectedRepository?.id).some(r => r.id === message.id && r.gerritPatch)) { selectedGerritRun = message.id; historyTab = 'gerrit'; update(); } break;
          case 'historyTab': if (['local', 'gerrit'].includes(message.value)) { historyTab = message.value; update(); } break;
          case 'settingsTab':
            if (SETTINGS_TABS.includes(message.value)) { settingsTab = message.value; await context.workspaceState.update('settingsTab', settingsTab); update(); }
            break;
          case 'finding': {
            if (!Number.isInteger(message.resultIndex) || !Number.isInteger(message.commentIndex)) throw new Error(t('Invalid finding.'));
            const finding = await service.finding(message.id, message.resultIndex, message.commentIndex);
            await showSnapshot(`${finding.sha.slice(0, 10)}/${finding.file.replace(/^\//, '')}`, finding.content, finding.line);
            break;
          }
        }
      })));
    },
  }));
  service.on('log', ({ id, text }) => { if (id === logRun) output.append(text); });
  service.on('changed', id => {
    const changed = service.runs.get(id);
    if (statistics.record(changed)) {
      if (finished(changed)) void saveStatistics().catch(error);
      else if (!statisticsTimer) statisticsTimer = setTimeout(() => { void saveStatistics().catch(error); }, 5000);
    }
    accountLimits.seed(changed.agent, changed.usage?.limits);
    if (changed.status === 'running' && latestActiveId !== id) {
      reviewError = false; notice = '';
      latestActiveId = id; currentReview = id; void context.workspaceState.update('currentReview', id); setStatsCleared(false); draftKey = draft();
      // The batch Review showed before is no longer protected from clean-up.
      void sweepHistory();
      if (changed.repository === selectedRepository?.id) {
        showReview(changed);
      }
    }
    clearTimeout(timer); timer = setTimeout(update, 100);
  });
  service.on('finished', guarded(async id => {
    const run = service.runs.get(id);
    reviewError = false; notice = '';
    if (run.repository === selectedRepository?.id) selected.clear();
    gerritPatches.clear(false);
    draftKey = draft();
    await context.workspaceState.update(`selected:${run.repository}`, []);
    // Finished, unpublished Gerrit reviews become visible to other windows.
    if (run.gerritPatches?.length) await registry.record(run).catch(error => output.appendLine(`Published reviews: ${error.message}`));
    const automatic = autoOpenReports;
    if (automatic) openingReports.add(id);
    try {
      await indexReports(run);
      await updateBranchMembers().catch(e => output.appendLine(`Reports & History: ${e.message}`));
      if (automatic) await openReports(id, false);
    } finally { openingReports.delete(id); update(); }
  }));
  const gitApi = (await vscode.extensions.getExtension('vscode.git').activate()).getAPI(1);
  const repoSubscriptions = new Map();
  const watchRepositories = () => {
    for (const [repo, disposable] of repoSubscriptions) if (!gitApi.repositories.includes(repo)) { disposable.dispose(); repoSubscriptions.delete(repo); }
    for (const repo of gitApi.repositories) if (!repoSubscriptions.has(repo)) {
      const headIdentity = () => JSON.stringify([repo.state.HEAD?.commit, repo.state.HEAD?.name, repo.state.HEAD?.type]);
      let head = headIdentity();
      repoSubscriptions.set(repo, repo.state.onDidChange(() => {
        if (headIdentity() !== head) { head = headIdentity(); void guarded(refresh)(); }
      }));
    }
    return guarded(refresh)();
  };
  context.subscriptions.push(gitApi.onDidOpenRepository(watchRepositories), gitApi.onDidCloseRepository(watchRepositories),
    vscode.workspace.onDidChangeWorkspaceFolders(watchRepositories),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('lustreReview')) {
        // Another language: the page is written again in it, and the messages
        // kept from earlier checks are read again.
        if (event.affectsConfiguration('lustreReview.language') && l10n.resolveLanguage(languageSetting(), vscode.env.language) !== translation.language) {
          translation = l10n.use(l10n.resolveLanguage(languageSetting(), vscode.env.language));
          mcpMessages.clear(); notice = '';
          if (view) view.webview.html = reviewHtml(view.webview, vscode, context.extensionUri, translation, languageInfo());
          void gerrit.refresh(gerritCwd()); refreshMcp(true);
          for (const run of service.runs.values()) if (finished(run) && !hiddenHistory.has(run.id)) void indexReports(run);
        }
        service.modelCache.clear();
        if (event.affectsConfiguration('lustreReview.lreviewPath')) void checkLreview(true);
        if (['codexPath', 'claudePath', 'auggiePath'].some(key => event.affectsConfiguration(`lustreReview.${key}`))) {
          connections.invalidate(); void connections.refreshAll();
          accountLimits.invalidate(); refreshLimits();
        }
        if (event.affectsConfiguration('lustreReview.mode')) mode = config().get('mode');
        void guarded(refresh)();
      }
    }), { dispose: () => { for (const d of repoSubscriptions.values()) d.dispose(); clearTimeout(timer); } });
  await watchRepositories();
  context.subscriptions.push(vscode.window.onDidChangeWindowState(event => {
    if (event.focused) { void connections.refreshAll(true); void checkLreview(true); void checkGit(true); void checkDashboard(true); refreshMcp(true); }
  }), vscode.window.onDidCloseTerminal(terminal => {
    for (const [target, pending] of loginTerminals) if (pending === terminal) {
      loginTerminals.delete(target); service.modelCache.delete(target);
      accountLimits.invalidate(); void connections.refresh(target, true);
    }
  }));
  void connections.refreshAll(); void checkLreview(); void checkGit(); void gerrit.refresh(gerritCwd());
  const authTimer = setInterval(() => {
    if (disposed) return;
    for (const target of loginTerminals.keys()) {
      void connections.refresh(target, true).then(() => {
        if (connections.get(target).status === 'connected') {
          loginTerminals.delete(target); service.modelCache.delete(target);
          accountLimits.invalidate(); refreshLimits();
        }
      });
    }
    if (view && view.visible !== false && section === 'settings') { void connections.refreshAll(); void checkLreview(); void checkGit(); refreshMcp(); }
  }, 3000);
  // Refresh only the visible Review section, at most once a minute per agent.
  limitsTimer = setInterval(refreshLimits, 60000);
  const globalStatisticsTimer = setInterval(() => {
    if (disposed) return;
    void statistics.sync().then(update).catch(e => output.appendLine(`Usage statistics: ${e.message}`));
    void registry.refresh().then(changed => { if (changed) update(); });
    void queue.reload().then(changed => { if (changed) update(); }).catch(() => {});
    void links.reload().then(changed => { if (changed) update(); }).catch(() => {});
  }, 5000);
  // Every five minutes, by whichever window of the project gets there first:
  // the review lists of a project already loaded, and the commit links. The
  // interval varies a little per window so that windows do not line up.
  let autoAttempt = 0;
  const autoTimer = setInterval(() => {
    if (disposed) return;
    void sweepHistory({ gerrit: true });
    if (!projectInfo?.project || !selectedRepository) return;
    checkLinks();
    const data = queue.get(projectInfo.project);
    if (dashboardStatus.status !== 'installed') { void checkDashboard(); return; }
    if (!data.loaded || data.refreshing || Date.now() - Date.parse(data.refreshedAt) < AUTO_REFRESH || Date.now() - autoAttempt < AUTO_REFRESH) return;
    autoAttempt = Date.now();
    void queue.refresh(projectInfo.project, selectedRepository.path, { auto: true });
  }, 60000 + Math.floor(Math.random() * 15000));
  shutdown = async () => { disposed = true; ++refreshSequence; clearTimeout(timer); clearInterval(limitsTimer); clearInterval(authTimer); clearInterval(globalStatisticsTimer); clearInterval(autoTimer); for (const check of mcpChecks.values()) check.controller.abort(); gerrit.dispose(); gerritPatches.dispose(); connections.dispose(); accountLimits.dispose(); await bridge.dispose(); await service.dispose(); await saveStatistics(); };
  return { listRepositories: () => service.repositories, listModels: agent => service.models(false, agent),
    startReview: input => service.start(input), getReview: id => service.get(id) };
}

async function deactivate() { if (shutdown) await shutdown(); }
module.exports = { activate, deactivate };
