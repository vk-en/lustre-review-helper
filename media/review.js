/* global acquireVsCodeApi, scanner */
'use strict';
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
// The language of the page. Its text is English; t() and tn() look a text up
// in the dictionary that comes with the page, tn() choosing the plural form.
const L10N = (() => { try { return JSON.parse($('l10nData')?.textContent || '{}'); } catch { return {}; } })();
const WORDS = L10N.words || {}, LANGUAGE = L10N.language || 'en', LOCALE = L10N.locale || 'en-GB';
const PLURALS = new Intl.PluralRules(LOCALE);
const fill = (text, values = {}) => String(text).replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
const t = (text, values) => fill(typeof WORDS[text] === 'string' && WORDS[text] ? WORDS[text] : text, values);
const tn = (count, one, other, values = {}) => {
  const all = { n: count, ...values }, entry = WORDS[other];
  if (entry && typeof entry === 'object') { const form = entry[PLURALS.select(count)] || entry.other; if (form) return fill(form, all); }
  return fill(count === 1 ? one : other, all);
};
const formatNumber = value => value.toLocaleString(LOCALE);
const send = (type, data = {}) => vscode.postMessage({ type, ...data });
let state = {};
let displayedDetails;
let displayedCommits;
let displayedSelection;
// The Gerrit review whose publish lock is open. Choosing another review,
// publishing or reloading the view locks it again.
let unlockedPublish;
let displayedTotals;
let displayedGerritPatches;
let displayedGerritSelection;
let submittedGerritUrl;
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const on = (id, event, handler) => $(id)?.addEventListener(event, handler);
const agentName = agent => ({codex:'Codex',claude:'Claude Code',auggie:'Augment'})[agent] || agent || t('Unknown');
// The branch as Git names it, or what stands in for one.
const branchText = branch => /^Detached HEAD · /.test(branch || '') ? t('Detached HEAD · {sha}', { sha: branch.replace(/^Detached HEAD · /, '') }) :
  branch === 'Branch unavailable' ? t('Branch unavailable') : branch || '';
for (const [id, type] of [['model', 'model'], ['review', 'run'], ['cancel', 'cancel'],
  ['logs', 'logs'], ['reports', 'reports'], ['refreshConnections', 'connections'], ['refresh', 'refresh'],
  ['clearNotifications', 'clearNotifications'], ['clearHistory', 'clearHistory'], ['lreviewDownload', 'lreviewDownload'],
  ['lreviewHelp', 'lreviewHelp'], ['gitHelp', 'gitHelp'], ['gitDownload', 'gitDownload'],
  ['gerritHelp', 'gerritHelp'], ['gerritConfig', 'gerritConfig'], ['gerritCheck', 'gerritCheck'],
  ['resetStatistics', 'resetStatistics'], ['dashboardHelp', 'dashboardHelp'], ['dashboardDownload', 'dashboardDownload'],
  ['repositoryPicker', 'repository'], ['selectAll', 'selectAll'], ['clearSelection', 'clearSelection'], ['toggleMerged', 'toggleMerged']]) {
  on(id, 'click', () => send(type));
}
for (const id of ['effort', 'agent', 'mode']) on(id, 'change', () => send(id, { value: $(id).value }));
on('gerritReports', 'click', () => send('gerritReports', { id: state.gerritRun?.id }));
// The diff button opens the remembered scope; its arrow chooses the other one.
const diffRun = tab => tab === 'gerrit' ? state.gerritRun : state.run;
const commentedFiles = run => new Set((run?.results?.[0]?.comments || []).map(comment =>
  ['/COMMIT_MSG', 'COMMIT_MSG', 'COMMIT_MESSAGE'].includes(comment.file) ? '/COMMIT_MSG' : comment.file)).size;
const diffScope = run => state.diffScope === 'all' || !commentedFiles(run) ? 'all' : 'commented';
function closeDiffMenus(focus) {
  for (const tab of ['local', 'gerrit']) {
    if ($(`${tab}DiffOptions`).hidden) continue;
    $(`${tab}DiffOptions`).hidden = true;
    $(`${tab}DiffMenu`).setAttribute('aria-expanded', 'false');
    if (focus) $(`${tab}DiffMenu`).focus();
  }
}
for (const tab of ['local', 'gerrit']) {
  on(`${tab}Diff`, 'click', () => send('reviewDiff', { id: diffRun(tab)?.id, scope: diffScope(diffRun(tab)) }));
  on(`${tab}DiffMenu`, 'click', event => {
    event.stopPropagation();
    const open = $(`${tab}DiffOptions`).hidden;
    closeDiffMenus();
    const menu = $(`${tab}DiffOptions`);
    menu.hidden = !open;
    menu.classList.remove('above');
    $(`${tab}DiffMenu`).setAttribute('aria-expanded', String(open));
    // Open upward near the bottom of the pane; scroll only if neither side fits.
    const box = menu.getBoundingClientRect(), area = menu.closest('.pane-body')?.getBoundingClientRect();
    if (open && area && box.bottom > area.bottom) {
      if (box.top - box.height - 8 - $(`${tab}DiffMenu`).offsetHeight >= area.top) menu.classList.add('above');
      else menu.scrollIntoView({ block: 'nearest' });
    }
    if (open) $(`${tab}DiffOptions`).querySelector('[aria-checked="true"]:not(:disabled), button:not(:disabled)')?.focus();
  });
  $(`${tab}DiffOptions`).addEventListener('keydown', event => {
    const items = [...$(`${tab}DiffOptions`).querySelectorAll('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    const next = { ArrowDown: index + 1, ArrowUp: index - 1 }[event.key];
    if (next !== undefined) { event.preventDefault(); items[(next + items.length) % items.length]?.focus(); }
    if (event.key === 'Escape' || event.key === 'Tab') closeDiffMenus(event.key === 'Escape');
  });
}
document.querySelectorAll('.diff-menu button').forEach(item => item.addEventListener('click', () => {
  const run = diffRun(item.dataset.tab);
  state.diffScope = item.dataset.scope;
  closeDiffMenus(true);
  send('diffScope', { value: item.dataset.scope });
  send('reviewDiff', { id: run?.id, scope: item.dataset.scope });
  renderHistory();
}));
document.addEventListener('click', event => { if (!event.target.closest('.diff-split')) closeDiffMenus(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDiffMenus(true); });
on('publishLock', 'click', () => {
  unlockedPublish = unlockedPublish === state.gerritRun?.id ? undefined : state.gerritRun?.id;
  renderHistory();
});
on('publishGerrit', 'click', () => {
  const id = state.gerritRun?.id;
  if (!id || unlockedPublish !== id) return;
  unlockedPublish = undefined;
  $('publishGerrit').disabled = true;
  send('publishGerrit', { id });
  renderHistory();
});
const historyTabs = [...document.querySelectorAll('.history-tab')];
// Tabs take the width of their content. When that no longer fits, shorten
// them step by step; the panel width alone cannot tell, since NEW badges come and go.
const tabStrip = document.querySelector('.history-tabs');
function fitStrip(strip) {
  const tabs = [...strip.querySelectorAll('.folder-tab')];
  // A label may shrink with an ellipsis instead of overflowing; both count.
  const clipped = () => tabs.some(tab => [...tab.querySelectorAll('.tab-inner, .tab-label, .tab-full, .tab-short')]
    .some(part => part.scrollWidth > part.clientWidth + 1)) || strip.scrollWidth > strip.clientWidth + 1;
  strip.classList.remove('compact', 'tiny', 'icons');
  if (!strip.clientWidth) return;
  if (clipped()) strip.classList.add('compact');
  if (clipped()) strip.classList.add('tiny');
  if (clipped()) strip.classList.add('icons');
}
const fitTabs = () => fitStrip(tabStrip);
document.querySelectorAll('.folder-tabs').forEach(strip => new ResizeObserver(() => fitStrip(strip)).observe(strip));

// AI Settings categories, drawn like the Reports & History tabs.
const SETTINGS_TABS = ['accounts', 'agent', 'utilities', 'mcp', 'other', 'language'];
const settingsStrip = document.querySelector('.settings-tabs');
const settingsTabs = [...settingsStrip.querySelectorAll('.folder-tab')];
function renderSettingsTabs() {
  const current = SETTINGS_TABS.includes(state.settingsTab) ? state.settingsTab : 'accounts';
  for (const tab of settingsTabs) {
    const selected = tab.dataset.tab === current;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const page of document.querySelectorAll('.settings-page')) page.hidden = page.dataset.page !== current;
  $('settingsPanel').setAttribute('aria-labelledby', `settingsTab-${current}`);
  $('mcpExamples').hidden = current !== 'mcp';
  // A dot marks a category that needs attention; its tooltip says why.
  const tools = [['git', state.git], ['lreview', state.lreview], ['gerrit-cli', state.gerrit]]
    .filter(([, entry]) => ['missing', 'outdated'].includes(entry?.status)).map(([name, entry]) => entry.status === 'outdated' ? t('{tool} is too old', { tool: name }) : t('{tool} is not installed', { tool: name }));
  const entries = state.connections || [], connected = entries.some(entry => entry.status === 'connected');
  const alerts = { utilities: tools.join('; '),
    accounts: entries.length && !connected && entries.every(entry => entry.status !== 'checking') ? t('No agent is signed in') : '',
    agent: connected && !state.model ? t('No model is chosen') : '' };
  for (const tab of settingsTabs) {
    const alert = alerts[tab.dataset.tab] || '';
    $(`settingsAlert-${tab.dataset.tab}`).hidden = !alert;
    tab.title = alert ? `${tab.dataset.tip}\n⚠ ${alert}.` : tab.dataset.tip;
  }
  fitStrip(settingsStrip);
}
settingsTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => {
    if (state.settingsTab === tab.dataset.tab) return;
    state.settingsTab = tab.dataset.tab;
    renderSettingsTabs();
    send('settingsTab', { value: tab.dataset.tab });
  });
  tab.addEventListener('keydown', event => {
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: settingsTabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = settingsTabs[(next + settingsTabs.length) % settingsTabs.length];
    target.focus(); target.click();
  });
});
// Language: a list of the languages with their flags, Automatic first.
// Choosing one has the extension reload the page in that language.
const languageOptions = [...document.querySelectorAll('.language-option')];
let languageOpen = false;
function renderLanguage() {
  const setting = state.language?.setting || 'auto';
  for (const option of languageOptions) option.setAttribute('aria-selected', String(option.dataset.language === setting));
  const chosen = languageOptions.find(option => option.dataset.language === setting) || languageOptions[0];
  if (!chosen || $('languageChosen').dataset.language === chosen.dataset.language) return;
  $('languageChosen').replaceChildren(...[...chosen.children].filter(node => !node.classList.contains('language-check')).map(node => node.cloneNode(true)));
  $('languageChosen').dataset.language = chosen.dataset.language;
}
function setLanguageActive(option, scroll = true) {
  for (const item of languageOptions) item.classList.toggle('active', item === option);
  if (!option) return;
  $('languageList').setAttribute('aria-activedescendant', option.id);
  if (scroll) option.scrollIntoView({ block: 'nearest' });
}
function openLanguage(open, focus = false) {
  languageOpen = open;
  $('languageList').hidden = !open;
  $('languageTrigger').setAttribute('aria-expanded', String(open));
  if (open) {
    setLanguageActive(languageOptions.find(option => option.getAttribute('aria-selected') === 'true') || languageOptions[0]);
    $('languageList').focus({ preventScroll: true });
  } else if (focus) $('languageTrigger').focus();
}
function chooseLanguage(option) {
  openLanguage(false, true);
  if (!option || option.getAttribute('aria-selected') === 'true') return;
  state.language = { ...state.language, setting: option.dataset.language };
  renderLanguage();
  send('language', { value: option.dataset.language });
}
on('languageTrigger', 'click', () => openLanguage(!languageOpen));
on('languageTrigger', 'keydown', event => { if (['ArrowDown', 'ArrowUp'].includes(event.key) && !languageOpen) { event.preventDefault(); openLanguage(true); } });
on('languageList', 'keydown', event => {
  const index = languageOptions.findIndex(option => option.classList.contains('active'));
  const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: languageOptions.length - 1 }[event.key];
  if (next !== undefined) { event.preventDefault(); setLanguageActive(languageOptions[Math.max(0, Math.min(languageOptions.length - 1, next))]); }
  else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseLanguage(languageOptions[index]); }
  else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); openLanguage(false, true); }
  else if (event.key === 'Tab') openLanguage(false);
});
on('languageList', 'click', event => { const option = event.target.closest('.language-option'); if (option) chooseLanguage(option); });
on('languageList', 'mousemove', event => { const option = event.target.closest('.language-option'); if (option && !option.classList.contains('active')) setLanguageActive(option, false); });
document.addEventListener('mousedown', event => { if (languageOpen && !event.target.closest('#languagePicker')) openLanguage(false); });

historyTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => {
    if (state.historyTab === tab.dataset.tab) return;
    state.historyTab = tab.dataset.tab;
    renderHistory();
    send('historyTab', { value: tab.dataset.tab });
  });
  tab.addEventListener('keydown', event => {
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: historyTabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = historyTabs[(next + historyTabs.length) % historyTabs.length];
    target.focus(); target.click();
  });
});
on('autoOpenReports', 'change', () => send('autoOpenReports', { value: $('autoOpenReports').checked }));
on('toggleUsage', 'click', () => {
  const open = $('usageDetails').hidden;
  $('usageDetails').hidden = !open;
  $('toggleUsage').textContent = open ? t('Hide') : t('Show');
  $('toggleUsage').setAttribute('aria-expanded', String(open));
  $('toggleUsage').setAttribute('aria-label', open ? t('Hide all-time usage') : t('Show all-time usage'));
});
on('commitSettings', 'submit', event => {
  event.preventDefault();
  if ($('commitLimit').reportValidity()) send('commitLimit', { value: $('commitLimit').valueAsNumber });
});
on('addGerritPatch', 'submit', event => {
  event.preventDefault();
  if ($('gerritPatchAdd').disabled) return;
  submittedGerritUrl = $('gerritPatchUrl').value.trim();
  send('addGerritPatch', { url: submittedGerritUrl });
});
on('gerritPatchUrl', 'input', () => renderGerritPatches());

function renderGerritPatches() {
  const patches = state.gerritPatches || {}, items = patches.items || [];
  const pending = !!patches.pending;
  if (!pending && submittedGerritUrl && patches.addedUrl === submittedGerritUrl) {
    if ($('gerritPatchUrl').value.trim() === submittedGerritUrl) $('gerritPatchUrl').value = '';
    submittedGerritUrl = undefined;
  }
  const unavailable = state.gerrit?.installed !== true;
  // A running review cannot take more patches; its end clears this list.
  const locked = !!state.busy, lockedText = t('Wait for the current review to finish before adding or removing patches.');
  $('gerritPatchUrl').disabled = locked;
  $('gerritPatchAdd').disabled = pending || unavailable || locked || !state.repository || !$('gerritPatchUrl').value.trim();
  $('gerritPatchAdd').textContent = pending ? t('Please wait…') : t('Add commit');
  $('gerritPatchAdd').title = locked ? lockedText : !state.repository ? t('Choose a Git repository in Local commits first.') : unavailable ? t('Install gerrit-cli in AI Settings to add patches.') : t('Check the patch and its repository, then add it to the list.');
  $('addGerritPatch').setAttribute('aria-busy', String(pending));
  // The add result first; otherwise what keeps Gerrit from working, with its fix.
  const problem = gerritProblem(), notice = $('gerritPatchMessage');
  if (locked) setNotice(notice, lockedText);
  else if (patches.message) setNotice(notice, patches.message, patches.error && problem ? problem[1] : [], !!patches.error);
  else if (!state.repository) setNotice(notice, t('Choose a Git repository in Local commits first.'), [FIX.repository]);
  else if (problem) setNotice(notice, ...problem);
  else if (unavailable) setNotice(notice, t('Checking Gerrit CLI installation…'));
  else setNotice(notice, '');
  $('gerritPatchUrl').setAttribute('aria-invalid', String(!!patches.error));
  $('gerritPatchCount').textContent = String(items.length);
  $('gerritPatchCount').title = tn(items.length, '{n} Gerrit patch added', '{n} Gerrit patches added');
  $('gerritPatchCount').setAttribute('aria-label', $('gerritPatchCount').title);
  $('gerritPatchCount').classList.toggle('has-selection', items.length > 0);
  $('gerritPatchesEmpty').hidden = items.length > 0;
  const signature = JSON.stringify(items);
  if (signature !== displayedGerritPatches) {
    $('gerritPatchList').replaceChildren(...items.map(patch => {
      const row = element('li', undefined, 'gerrit-patch-row');
      const details = element('div', undefined, 'gerrit-patch-details');
      const subject = element('strong', patch.subject); subject.title = patch.url;
      const author = element('p', t('By {owner}', { owner: patch.owner || t('Unknown author') }), 'hint'); author.title = t('Gerrit change owner');
      details.append(subject, author, element('p', `#${patch.number} · ${t('Patchset {n}', { n: patch.patchset })}${patch.project ? ` · ${patch.project}` : ''}`, 'hint'));
      const remove = element('button', '×', 'gerrit-patch-remove'); remove.type = 'button';
      remove.title = t('Remove from list'); remove.setAttribute('aria-label', t('Remove change #{number}', { number: patch.number }));
      remove.addEventListener('click', () => send('removeGerritPatch', { number: patch.number }));
      row.append(details, remove); return row;
    }));
    displayedGerritPatches = signature;
  }
  for (const button of $('gerritPatchList').querySelectorAll('button')) { button.disabled = pending || locked; button.title = locked ? lockedText : t('Remove from list'); }
  $('gerritSelection').textContent = `${tn(items.length, '{n} Gerrit patch selected', '{n} Gerrit patches selected')}${items.length ? ':' : ''}`;
  $('selectedGerritPatches').hidden = !items.length;
  if (signature !== displayedGerritSelection) {
    $('selectedGerritPatches').replaceChildren(...items.map(patch => {
      const row = element('li');
      row.append(element('span', patch.subject), element('small', `#${patch.number} · ${t('Patchset {n}', { n: patch.patchset })}`, 'muted'));
      return row;
    }));
    displayedGerritSelection = signature;
  }
}

document.querySelectorAll('[data-help]').forEach(button => button.addEventListener('click', () => send('agentHelp', { agent: button.dataset.help })));
document.querySelectorAll('[data-mcp]').forEach(button => button.addEventListener('click', () => send('connectMcp', { agent: button.dataset.mcp })));
document.querySelectorAll('[data-agent]').forEach(button => button.addEventListener('click', () => {
  const entry = state.connections?.find(entry => entry.agent === button.dataset.agent);
  send('authenticate', { agent: button.dataset.agent, action: entry?.status === 'connected' ? 'logout' : 'login' });
}));
let savedBotName;
on('gerritBotSettings', 'submit', event => {
  event.preventDefault();
  if ($('gerritBotName').reportValidity()) send('gerritBotName', { value: $('gerritBotName').value });
});
on('gerritBotName', 'input', () => { $('gerritBotSave').disabled = $('gerritBotName').value.trim() === (state.gerritBotName || ''); });
on('gerritSignatureDetails', 'change', () => send('gerritSignatureDetails', { value: $('gerritSignatureDetails').checked }));
// What an installation check found: installed with its version, missing, or still checking.
const installedText = (entry, version = entry.version) => entry.installed ? `✓ ${t('Installed')}${version ? ` · ${version}` : ''}` :
  entry.status === 'missing' ? `✕ ${t('Not installed')}` : t('Checking installation…');
function renderGerrit() {
  const entry = state.gerrit || {};
  $('gerritInstallation').textContent = installedText(entry);
  $('gerritInstallation').className = `connection-status connection-${entry.installed ? 'connected' : entry.status === 'missing' ? 'missing' : 'checking'}`;
  $('gerritPath').textContent = entry.path || '';
  $('gerritConfigPath').textContent = entry.configFile || '';
  $('gerritConnection').textContent = { connected: `✓ ${t('Connected')}`, disconnected: `✕ ${t('Authentication failed')}`, unconfigured: `✕ ${t('Not configured')}`,
    unavailable: `✕ ${t('Unreachable')}`, error: `✕ ${t('Check failed')}`, unknown: t('Status unavailable'), unchecked: t('Not checked'), missing: `✕ ${t('Unavailable')}` }[entry.status] || t('Checking…');
  $('gerritConnection').className = `connection-status connection-${entry.status === 'connected' ? 'connected' : ['unconfigured','disconnected','unavailable','error','missing'].includes(entry.status) ? 'disconnected' : 'unknown'}`;
  $('gerritCheck').disabled = !!entry.pending;
  $('gerritCheck').textContent = entry.pending ? t('Checking…') : t('Check connection');
  $('gerritConnectionHint').textContent = entry.pending ? t('Checking authentication without publishing comments…') : entry.message || '';
  const name = state.gerritBotName || '';
  // Background updates must not overwrite a name the user is still typing.
  if (savedBotName !== name) { $('gerritBotName').value = name; savedBotName = name; }
  $('gerritBotSave').disabled = $('gerritBotName').value.trim() === name;
  // The signature itself is what Gerrit shows, so it stays in English.
  const reasoning = state.effort || 'Default';
  $('gerritSignatureDetails').checked = state.gerritSignatureDetails === true;
  const details = state.gerritSignatureDetails ? ` - ${state.model?.name || state.model?.id || 'model'} - ${reasoning}` : '';
  const signature = `[${name || 'AI review'}${details}]`;
  $('gerritBotSaved').textContent = name ? t('Saved signature: {signature}', { signature }) : t('Default signature: {signature}', { signature });
}
function renderGit() {
  const entry = state.git || {};
  $('gitInstallation').textContent = entry.status === 'outdated' ? `✕ ${t('Version {version} is too old · requires {minimum} or newer', { version: entry.version, minimum: entry.minimum })}` :
    installedText(entry);
  $('gitInstallation').className = `connection-status connection-${entry.installed ? 'connected' : ['missing', 'outdated'].includes(entry.status) ? 'missing' : 'checking'}`;
  $('gitPath').textContent = entry.path || (entry.status === 'missing' ? t('Install Git and make sure it is on PATH, then refresh connections.') : '');
  $('gitDownload').hidden = !['missing', 'outdated'].includes(entry.status);
}
function renderConnections() {
  renderGerrit();
  renderGit();
  const prerequisite = state.lreview || {};
  $('lreviewStatus').textContent = installedText(prerequisite);
  $('lreviewStatus').className = `connection-status connection-${prerequisite.installed ? 'connected' : prerequisite.status === 'missing' ? 'missing' : 'checking'}`;
  $('lreviewPath').textContent = prerequisite.path || (prerequisite.status === 'missing' ? t('Required for reviews. Install lreview or set its executable path in VS Code settings.') : '');
  $('lreviewDownload').hidden = prerequisite.status !== 'missing';
  const entries = state.connections || [];
  const connected = entries.filter(entry => entry.status === 'connected');
  $('modelSettings').hidden = !connected.length;
  $('agentEmpty').hidden = connected.length > 0;
  for (const entry of entries) {
    const label = $(entry.agent + 'Connection');
    const button = $(entry.agent + 'Auth');
    if (!label || !button) continue;
    label.textContent = { connected: `✓ ${t('Connected')}`, disconnected: `✕ ${t('Disconnected')}`, missing: `✕ ${t('Disconnected')}`, checking: t('Checking…'), unknown: t('Status unavailable') }[entry.status];
    label.className = `connection-status connection-${entry.status}`;
    button.textContent = entry.pending ? t('Please wait…') : entry.status === 'connected' ? t('Sign out') : t('Sign in');
    button.disabled = !!state.busy || entry.pending || !entry.installed || entry.status === 'checking';
    $(entry.agent + 'Version').textContent = entry.version ? `v${entry.version}` : '';
    const mcp = state.mcpSetup?.[entry.agent];
    const mcpButton = $(entry.agent + 'Mcp');
    const client = entry.agent === 'auggie' ? 'Auggie CLI' : agentName(entry.agent);
    mcpButton.textContent = mcp?.pending ? t('Connecting…') : mcp?.configured ? t('{agent} configured', { agent: client }) :
      ['disabled', 'outdated', 'otherWorkspace'].includes(mcp?.status) ? t('Reconnect {agent}', { agent: client }) : t('Connect {agent}', { agent: client });
    mcpButton.disabled = !!state.busy || !!mcp?.pending || !!mcp?.configured || mcp?.status === 'checking' || !entry.installed || !state.repository;
    const mcpStatus = $(entry.agent + 'McpStatus');
    mcpStatus.replaceChildren();
    if (mcp?.configured) mcpStatus.append(element('span', '✓ ', 'mcp-configured'));
    if (mcp?.message) mcpStatus.append(document.createTextNode(mcp.message));
    $(entry.agent + 'ConnectionHint').textContent = entry.status === 'missing' ? t('CLI not installed. Open ? for the setup guide, or configure its executable path in VS Code settings.') :
      entry.status === 'unknown' ? t('Could not check this account. Check your connection or update the CLI, then refresh.') : '';
  }
  const signature = connected.map(entry => entry.agent).join(',');
  if ($('agent').dataset.connections !== signature) {
    $('agent').replaceChildren(...connected.map(entry => new Option(agentName(entry.agent), entry.agent)));
    $('agent').dataset.connections = signature;
  }
}

const headers = [...document.querySelectorAll('.pane-toggle')];
function renderSection(section) {
  if (!headers.some(header => header.dataset.section === section)) section = 'review';
  for (const header of headers) {
    const open = header.dataset.section === section;
    header.setAttribute('aria-expanded', String(open));
    $(header.getAttribute('aria-controls')).hidden = !open;
  }
}
function selectSection(section) {
  state.section = section;
  renderSection(section);
  renderStats();
  send('section', { value: section });
}
headers.forEach((header, index) => {
  header.addEventListener('click', () => selectSection(header.getAttribute('aria-expanded') === 'true' ? 'review' : header.dataset.section));
  header.addEventListener('keydown', event => {
    const next = { ArrowDown: (index + 1) % headers.length, ArrowUp: (index + headers.length - 1) % headers.length,
      Home: 0, End: headers.length - 1 }[event.key];
    if (next !== undefined) { event.preventDefault(); headers[next].focus(); }
  });
});

// One segmented strip while every label fits on one line; otherwise outlined
// buttons two by two, and one column when two do not fit either.
const commitToolbar = document.querySelector('.commit-toolbar');
function fitToolbar() {
  const labels = [...commitToolbar.querySelectorAll('button span')];
  const fits = () => labels.every(label => label.scrollWidth <= label.clientWidth + 1) && commitToolbar.scrollWidth <= commitToolbar.clientWidth + 1;
  commitToolbar.classList.remove('segmented', 'single');
  if (!commitToolbar.clientWidth) return;
  commitToolbar.classList.add('segmented');
  if (fits()) return;
  commitToolbar.classList.remove('segmented');
  if (!fits()) commitToolbar.classList.add('single');
}
new ResizeObserver(fitToolbar).observe(commitToolbar);

function renderCommits() {
  const commits = state.commits || [];
  $('repositoryPath').textContent = state.repository || t('Choose repository…');
  const hidden = state.hideMerged && state.mergedBase ? state.mergedCount || 0 : 0;
  $('commitCount').textContent = !state.repository ? t('Open a local Git repository.') : !state.totalCommits ? t('No commits yet.') :
    hidden && !commits.length ? tn(state.totalCommits, '{n} recent commit is merged', 'All {n} recent commits are merged') :
    hidden ? t('{shown} of {total} recent commits · {hidden} merged hidden', { shown: commits.length, total: state.totalCommits, hidden }) :
    state.mergedBase && state.mergedCount ? tn(commits.length, '{n} recent commit · {merged} merged', '{n} recent commits · {merged} merged', { merged: state.mergedCount }) :
    tn(commits.length, '{n} recent commit · newest first', '{n} recent commits · newest first');
  $('commitCount').title = $('commitCount').textContent;
  const branch = branchText(state.branch);
  $('currentBranchText').textContent = branch;
  $('currentBranch').title = /^Detached HEAD/.test(state.branch || '') ? t('No current branch: {branch}', { branch }) : t('Current branch: {branch}', { branch });
  $('currentBranch').setAttribute('aria-label', t('Current Git branch: {branch}', { branch: branch || t('unavailable') }));
  $('currentBranch').hidden = !state.repository || !state.branch;
  const signature = JSON.stringify([state.repositoryId, commits.map(({selected, ...commit}) => commit)]);
  if (signature !== displayedCommits) {
    const repository = state.repositoryId;
    $('commits').replaceChildren(...commits.map(commit => {
      const row = element('li', undefined, 'commit-row');
      const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.dataset.sha = commit.sha;
      checkbox.setAttribute('aria-label', t('Select {subject} ({sha})', { subject: commit.subject, sha: commit.shortSha }));
      checkbox.addEventListener('change', () => send('selection', { repository, sha: commit.sha, checked: checkbox.checked }));
      const title = element('button', undefined, `commit-title${commit.merged ? ' merged' : ''}`);
      // Day and month of the author date, e.g. 16.10, in the order of the language.
      const date = new Date(commit.date), day = Number.isNaN(date.getTime()) ? '' : LANGUAGE === 'en' ?
        `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}` : date.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' });
      title.append(element('span', commit.subject), element('small', commit.shortSha, 'muted'));
      title.setAttribute('aria-label', t('{subject} ({sha}). Open the commit diff.', { subject: commit.subject, sha: commit.shortSha }));
      title.addEventListener('click', () => send('showCommit', { repository, sha: commit.sha }));
      // The commit's change on Gerrit: grey when there is none, green when it
      // holds this very commit, orange when it differs, blue once merged.
      const link = commit.gerrit || {};
      // Same commit as on Gerrit, but Gerrit cannot merge it: half the link turns red.
      const gerrit = element('button', undefined, `commit-gerrit link-${link.state || 'none'}${link.conflict && link.state === 'current' ? ' link-conflict' : ''}`); gerrit.type = 'button';
      gerrit.append(qicon('link'));
      gerrit.disabled = !link.number;
      gerrit.setAttribute('aria-label', !link.number ? linkWords(commit)[0] : link.conflict ? t('Open change {number} on Gerrit, which has a merge conflict', { number: link.number }) :
        t('Open change {number} on Gerrit', { number: link.number }));
      gerrit.addEventListener('click', () => send('openCommitChange', { repository, sha: commit.sha }));
      row.append(checkbox, element('small', day, 'commit-date'), gerrit, title);
      return withTip(row, () => commitCard(commit), true, `commit:${commit.sha}`);
    }));
    displayedCommits = signature;
    keepTip();
  }
  const selected = new Set(commits.filter(c => c.selected).map(c => c.sha));
  // A running review cannot take more commits; its end clears the selection.
  const locked = !!state.busy;
  for (const checkbox of $('commits').querySelectorAll('input')) { checkbox.checked = selected.has(checkbox.dataset.sha); checkbox.disabled = locked; }
  $('selectAll').disabled = !commits.length || locked;
  $('clearSelection').disabled = !selected.size || locked;
  const lockedTip = t('Wait for the current review to finish before changing the selection.');
  $('selectAllTip').textContent = locked ? lockedTip : !commits.length ? t('No commits to select.') :
    `${tn(commits.length, 'Select the {n} commit shown for review.', 'Select all {n} commits shown for review.')}${state.hideMerged && state.mergedCount ? ` ${t('Hidden merged commits stay unselected.')}` : ''}`;
  $('clearSelectionTip').textContent = locked ? lockedTip : selected.size ? tn(selected.size, 'Clear the selection of {n} commit.', 'Clear the selection of {n} commits.') : t('No commits are selected.');
  // Disabled buttons cannot take focus; let keyboard users reach the reason.
  for (const id of ['selectAll', 'clearSelection']) $(id).parentElement.tabIndex = $(id).disabled ? 0 : -1;
  $('repositoryPicker').disabled = locked;
  // Merged means already on the remote branch this work is based on, as of the last fetch.
  const mergedCount = state.mergedCount || 0;
  $('toggleMergedLabel').textContent = state.hideMerged ? t('Show merged') : t('Hide merged');
  $('toggleMerged').dataset.action = state.hideMerged ? 'show' : 'hide';
  $('toggleMerged').dataset.filter = state.hideMerged && state.mergedBase ? 'on' : 'off';
  $('toggleMerged').disabled = locked || !state.mergedBase;
  $('toggleMerged').parentElement.tabIndex = $('toggleMerged').disabled ? 0 : -1;
  $('toggleMergedTip').textContent = locked ? t('Wait for the current review to finish before changing the list.') :
    !state.mergedBase ? t('Cannot tell which commits landed: no remote branch to compare with. Fetch the project remote, then refresh.') :
    state.hideMerged ? tn(mergedCount, 'Show {n} commit already in {base}, as of your last fetch.', 'Show {n} commits already in {base}, as of your last fetch.', { base: state.mergedBase }) :
    tn(mergedCount, 'Hide {n} commit already in {base}, as of your last fetch.', 'Hide {n} commits already in {base}, as of your last fetch.', { base: state.mergedBase });
  $('repositoryPicker').title = locked ? t('Wait for the current review to finish before choosing another repository.') :
    state.repository ? `${t('Current project: {path}', { path: state.repository })}\n${t('Click to choose another repository.')}` : t('Choose a Git repository.');
  $('commitsLocked').hidden = !locked;
  fitToolbar();
  const picked = state.selectedCommits || [];
  $('selectedCommitCount').textContent = String(picked.length);
  $('selectedCommitCount').title = tn(picked.length, '{n} commit selected', '{n} commits selected');
  $('selectedCommitCount').setAttribute('aria-label', $('selectedCommitCount').title);
  $('selectedCommitCount').classList.toggle('has-selection', picked.length > 0);
  $('selection').textContent = `${tn(picked.length, '{n} local commit selected', '{n} local commits selected')}${picked.length ? ':' : ''}`;
  $('selectedCommits').hidden = !picked.length;
  const pickedSignature = JSON.stringify(picked);
  if (pickedSignature !== displayedSelection) {
    $('selectedCommits').replaceChildren(...picked.map(commit => {
      const row = element('li'); row.append(element('span', commit.subject), element('small', commit.shortSha, 'muted')); return row;
    }));
    displayedSelection = pickedSignature;
  }
}

const duration = seconds => {
  seconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(seconds / 3600);
  return (hours ? `${hours}:` : '') + `${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
const known = value => typeof value === 'number' && Number.isFinite(value);
function compactTokens(value) {
  if (!known(value)) return '—';
  // Promote rounded boundary values: 999,999 becomes 1M, never 1,000k.
  if (value >= 999950) return `${+(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${+(value / 1000).toFixed(1)}k`;
  return formatNumber(value);
}
// Tokens, exactly: 1,234,567 tokens; at least that many when some usage was not reported.
const tokenCount = (value, partial) => partial ? tn(value, 'At least {n} token', 'At least {n} tokens', { n: formatNumber(value) }) :
  tn(value, '{n} token', '{n} tokens', { n: formatNumber(value) });
function renderUsageTotals() {
  const rows = state.usageStatistics || [];
  $('resetStatistics').disabled = !!state.busy || !rows.length;
  $('resetStatisticsHelp').textContent = state.busy ? t('Wait for the current review to finish before resetting statistics.') :
    t('Reset accumulated usage across all projects. History and report files are kept. Counts new reviews started after reset.');
  const signature = JSON.stringify(rows);
  if (signature === displayedTotals) return;
  displayedTotals = signature;
  const body = $('usageTotals'); body.replaceChildren();
  if (!rows.length) {
    const row = element('tr'), cell = element('td', t('No usage yet.')); cell.colSpan = 4; row.append(cell); body.append(row);
  }
  for (const row of rows) {
    const tr = element('tr');
    const model = element('td', row.modelName || row.model || '—'); model.title = row.model || '';
    const cost = element('td', undefined, 'usage-number');
    if (known(row.cost)) {
      const usd = element('span', `${row.costPartial ? '≥ ' : ''}$${row.cost.toFixed(2)}${row.estimated ? '*' : ''}`);
      usd.title = row.estimated ? t('Includes estimated API cost, not subscription charges.') : t('Reported USD cost.');
      if (row.costPartial) usd.title += ` ${t('Some cost data was not reported.')}`;
      cost.append(usd);
    }
    if (known(row.credits)) {
      const credits = element('span', `${row.creditsPartial ? '≥ ' : ''}${t('{n} cr', { n: formatNumber(row.credits) })}`, 'usage-credits');
      credits.title = t('Reported Augment credits; separate from USD, not converted or added to dollars.');
      cost.append(credits);
    }
    if (!cost.childNodes.length) { cost.textContent = '—'; cost.title = t('Cost not reported.'); }
    const tokens = element('td', `${known(row.tokens) && row.tokenPartial ? '≥ ' : ''}${compactTokens(row.tokens)}`, 'usage-number');
    tokens.title = known(row.tokens) ? `${tokenCount(row.tokens, row.tokenPartial)}${row.tokenPartial ? `; ${t('some usage was not reported.')}` : ''}` : t('Tokens not reported.');
    tr.append(element('td', agentName(row.agent)), model, cost, tokens); body.append(tr);
  }
  $('usageTotalsNote').textContent = [rows.some(row => row.estimated) ? `* ${t('Includes API estimates.')}` : '',
    rows.some(row => (known(row.tokens) && row.tokenPartial) || (known(row.cost) && row.costPartial) || (known(row.credits) && row.creditsPartial)) ? `≥ ${t('Partial data.')}` : ''].filter(Boolean).join(' ');
}
function renderLimits() {
  const panel = $('limits');
  panel.replaceChildren();
  const account = state.accountLimits || { agent: state.agent };
  panel.hidden = !['codex', 'claude'].includes(account.agent);
  if (panel.hidden) return;
  panel.append(element('strong', t('{agent} account limits', { agent: agentName(account.agent) })));
  const snapshot = account.snapshot;
  const windows = (snapshot?.windows || []).filter(w => known(w.usedPercent) && (!w.resetsAt || w.resetsAt * 1000 > Date.now()));
  for (const window of windows) {
    const name = window.label ? window.label.replace(/^Weekly · /, `${t('Weekly')} · `) : window.minutes === 10080 ? t('Weekly') :
      window.minutes % 60 === 0 ? t('{n}-hour', { n: window.minutes / 60 }) : t('{n}-minute', { n: window.minutes });
    const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
    const left = t('{percent}% remaining', { percent: remaining.toFixed(1).replace(/\.0$/, '') });
    const meter = element('div', undefined, `limit-window quota-${Math.floor(remaining / 10)}`);
    const row = element('div', undefined, 'limit-label');
    row.append(element('span', name), element('span', left, 'remaining'));
    const bar = element('progress'); bar.max = 100; bar.value = remaining;
    bar.setAttribute('aria-label', t('{name} remaining', { name }));
    bar.setAttribute('aria-valuetext', left);
    meter.append(row, bar); panel.append(meter);
    if (window.resetsAt) {
      const minutes = Math.max(0, Math.ceil((window.resetsAt * 1000 - Date.now()) / 60000));
      const days = Math.floor(minutes / 1440), hours = Math.floor(minutes / 60) % 24;
      const time = [days ? t('{n}d', { n: days }) : '', hours ? t('{n}h', { n: hours }) : '', t('{n}m', { n: minutes % 60 })].filter(Boolean).join(' ');
      const reset = element('p', t('Resets in {time}', { time }), 'hint');
      reset.title = new Date(window.resetsAt * 1000).toLocaleString(LOCALE); meter.append(reset);
    }
  }
  const age = Math.max(0, (Date.now() - Date.parse(snapshot?.observedAt)) / 1000);
  const note = windows.length ? `${account.error ? t('Refresh unavailable · last known limits') : account.source === 'review' ? t('Last review snapshot') : t('Account-wide')} · ${t('updated {time} ago', { time: duration(age) })}${account.loading ? ` · ${t('refreshing…')}` : ''}` :
    account.loading ? t('Checking account limits…') : account.error ? t('Could not refresh account limits. Will retry automatically.') : t('Current limits not available for this account.');
  panel.append(element('p', note, 'hint'));
}
function renderStats() {
  if (!$('stats')) return;
  const run = state.statsRun;
  $('metrics').hidden = !run;
  const active = ['running', 'cancelling'].includes(run?.status);
  const reviewModel = run ? run.modelName || run.model : state.model?.name || state.model?.id;
  $('reviewConfiguration').textContent = [agentName(run ? run.agent : state.agent), reviewModel,
    reviewModel ? (run ? run.effort : state.effort) || t('Default') : undefined].filter(Boolean).join(' · ');
  const usage = run?.usage || {};
  const results = run?.results || [];
  const total = run?.commits?.length || 0;
  const reportedTokens = results.filter(r => known(r.tokens));
  const reportedCosts = results.filter(r => known(r.costUsd));
  const tokens = usage.tokens ?? (reportedTokens.length ? reportedTokens.reduce((n, r) => n + r.tokens, 0) : null);
  const cost = usage.estimatedCostUsd ?? usage.costUsd ?? (reportedCosts.length ? reportedCosts.reduce((n, r) => n + r.costUsd, 0) : null);
  const tokenPartial = usage.tokensPartial ?? reportedTokens.length < total;
  const costPartial = usage.costPartial ?? reportedCosts.length < total;
  const end = active ? Date.now() : Date.parse(run?.finishedAt || usage.sampledAt || run?.startedAt) || Date.now();
  // One line of numbers; what used to be notes under them is in their tooltips.
  $('elapsed').textContent = run ? duration((end - Date.parse(run.startedAt)) / 1000) : '00:00';
  $('elapsedFact').title = total > 1 ? t('Batch elapsed') : t('Elapsed');
  $('tokens').textContent = known(tokens) ? `${tokenPartial ? '≥ ' : ''}${compactTokens(tokens)}` : '—';
  $('tokensFact').title = known(tokens) ? `${tokenCount(tokens)}${tokenPartial ? `\n${t('Token usage is available for part of the batch.')}` : ''}` :
    active ? t('Waiting for token usage.') : t('Tokens not reported.');
  $('cost').textContent = known(cost) ? `${costPartial ? '≥ ' : ''}$${cost.toFixed(2)}` :
    known(usage.credits) ? `${costPartial ? '≥ ' : ''}${t('{n} cr', { n: formatNumber(usage.credits) })}` : '—';
  $('costFact').title = known(usage.estimatedCostUsd) ? `${t('API estimate')}\n${t('Standard text-token API rates, checked {date}. Excludes cache writes, tools, speed and region premiums. Not a subscription charge.', { date: '2026-10-15' })}` :
    known(cost) && run?.agent === 'claude' ? `${t('Est. cost')}\n${t('Claude’s API cost estimate, not a subscription charge.')}` :
    known(cost) ? t('Cost') : known(usage.credits) ? t('Credits') : t('Cost not reported by this agent.');
  // lreview writes its summary only at the end; its log says when each review is done.
  const logged = Object.values(run?.progress?.items || {}).filter(item => ['clean', 'findings', 'failed'].includes(item.state)).length;
  $('progress').textContent = `${Math.max(logged, usage.completed || 0, active ? 0 : results.length)} / ${total}`;
  const last = Date.parse(usage.lastActivityAt || run?.startedAt);
  const idle = Math.max(0, (end - last) / 1000);
  const stale = active && Date.now() - Date.parse(usage.sampledAt || run?.startedAt) > 10000;
  $('scanner').hidden = !active;
  scanner.setActive(active && state.section === 'review', run?.id);
  const status = !active ? run?.status || 'ready' : run.status === 'cancelling' ? 'stopping' : stale || idle >= 60 ? 'waiting' : 'running';
  const text = !active ? ({ completed: t('Review completed'), failed: t('Review failed'), cancelled: t('Review cancelled'), interrupted: t('Review interrupted') }[run?.status] || t('Ready for review')) :
    run.status === 'cancelling' ? t('Stopping…') : stale ? t('Waiting for status update…') : idle >= 60 ? t('Waiting for agent…') : t('Review in progress');
  renderActivity(status, text);
  $('lastActivity').textContent = active ? usage.lastActivityAt ? t('active {time} ago', { time: shortAge(idle) }) : t('no agent activity yet') : '';
  $('lastActivity').title = active ? t('Last agent activity') : '';
  renderLimits();
  renderBatch();
}
// The status next to the robot, as a colored pill once a review has started.
const ACTIVITY_TONE = { ready: 'idle', running: 'running', waiting: 'waiting', stopping: 'waiting', completed: 'done', failed: 'bad', interrupted: 'bad', cancelled: 'muted' };
const ACTIVITY_ICON = { done: 'check', bad: 'x', muted: 'x' };
function renderActivity(status, text) {
  const tone = ACTIVITY_TONE[status] || 'idle', node = $('activity');
  if (node.dataset.signature === `${tone}:${text}`) return;
  node.dataset.signature = `${tone}:${text}`;
  node.className = `status-pill tone-${tone}`;
  node.replaceChildren(...(tone === 'idle' ? [] : [ACTIVITY_ICON[tone] ? qicon(ACTIVITY_ICON[tone]) : element('i')]), document.createTextNode(text));
}
const shortAge = seconds => seconds < 60 ? t('{n}s', { n: Math.floor(seconds) }) : seconds < 3600 ? t('{n}m', { n: Math.floor(seconds / 60) }) :
  `${t('{n}h', { n: Math.floor(seconds / 3600) })} ${t('{n}m', { n: Math.floor(seconds / 60) % 60 })}`;

// While a batch runs, and until the user leaves Review, each commit or patch
// with its own state, time and findings replaces the list of selected ones.
let displayedBatch;
const FINDING_ORDER = ['defect', 'minor', 'suggestion', 'typo', 'style', 'nit', 'other'];
function batchItems(run) {
  const active = activeStatus(run.status);
  return (run.commits || []).map(key => {
    const patch = run.gerritPatches?.find(item => item.id === key);
    const result = run.results?.find(item => (item.target || item.sha) === key);
    const progress = run.progress?.items?.[key] || {};
    const state = result ? (['clean', 'findings', 'failed'].includes(result.status) ? result.status : 'cancelled') :
      progress.state && progress.state !== 'queued' ? progress.state : active ? 'queued' : 'cancelled';
    // Finished: the report's findings by type. Still running: the log only
    // gives a count, colored by its severity.
    const counts = result && run.summary?.commits?.find(item => item.sha === key)?.findings;
    const kinds = counts ? FINDING_ORDER.filter(kind => counts[kind] > 0).map(kind => [kind, counts[kind]]) :
      progress.findings > 0 ? [[/high|critical/i.test(progress.severity || '') ? 'defect' : 'minor', progress.findings]] : [];
    return { key, state, kinds, label: patch ? `#${patch.number}` : key.slice(0, 7), gerrit: !!patch,
      subject: run.subjects?.find(item => item.sha === key)?.subject || patch?.subject || '',
      duration: known(result?.duration) ? result.duration : progress.duration, startedAt: progress.startedAt,
      costUsd: known(result?.costUsd) ? result.costUsd : progress.costUsd };
  });
}
const BATCH_STATE = { queued: t('Queued'), running: t('Reviewing'), clean: t('No findings'), findings: t('Findings'), failed: t('Failed'), cancelled: t('Not reviewed') };
// A count of findings of one kind: 1 defect, 3 nits.
const FINDING_TEXT = {
  defect: n => tn(n, '{n} defect', '{n} defects'), minor: n => tn(n, '{n} minor', '{n} minor'), suggestion: n => tn(n, '{n} suggestion', '{n} suggestions'),
  typo: n => tn(n, '{n} typo', '{n} typos'), style: n => tn(n, '{n} style', '{n} style'), nit: n => tn(n, '{n} nit', '{n} nits'), other: n => tn(n, '{n} other', '{n} other'),
};
const findingText = (kind, count) => (FINDING_TEXT[kind] || FINDING_TEXT.other)(count);
function renderBatch() {
  const run = state.statsRun;
  $('selectionBlock').hidden = !!run;
  $('batchProgress').hidden = !run;
  if (!run) { displayedBatch = undefined; return; }
  const items = batchItems(run), active = activeStatus(run.status);
  const gerrit = items.filter(item => item.gerrit).length, local = items.length - gerrit;
  const what = [local ? tn(local, '{n} local commit', '{n} local commits') : '', gerrit ? tn(gerrit, '{n} Gerrit patch', '{n} Gerrit patches') : ''].filter(Boolean).join(` ${t('and')} `);
  $('batchTitle').textContent = active ? t('Reviewing {what}', { what }) : t('Reviewed {what}', { what });
  const signature = JSON.stringify([run.id, items.map(item => [item.key, item.state, item.kinds, item.costUsd, item.duration, item.startedAt])]);
  if (signature !== displayedBatch) {
    $('batchItems').replaceChildren(...items.map(item => {
      const row = element('li', undefined, `batch-item state-${item.state}`);
      row.dataset.key = item.key;
      const dot = element('span', undefined, `batch-dot${item.kinds.length ? ` kind-${item.kinds[0][0]}` : ''}`);
      const finds = element('span', undefined, 'batch-finds');
      for (const [kind, count] of item.kinds) {
        const mark = element('span', undefined, `kind-${kind}`);
        mark.title = findingText(kind, count);
        mark.append(element('i'), document.createTextNode(String(count)));
        finds.append(mark);
      }
      if (item.state === 'clean') { const mark = element('span', undefined, 'clean'); mark.title = t('No findings'); mark.append(qicon('check')); finds.append(mark); }
      if (item.state === 'failed') { const mark = element('span', undefined, 'failed'); mark.title = t('Failed'); mark.append(qicon('x')); finds.append(mark); }
      const time = element('span', '', 'batch-time'); time.dataset.key = item.key;
      row.append(dot, element('span', item.label, `batch-label${item.gerrit ? '' : ' sha'}`), element('span', item.subject, 'batch-subject'), finds, time);
      const opens = ['clean', 'findings', 'failed'].includes(item.state);
      const facts = [BATCH_STATE[item.state], ...(known(item.costUsd) ? [`$${item.costUsd.toFixed(2)}`] : [])].join(' · ');
      row.title = `${item.label} · ${item.subject}\n${facts}${opens ? `\n${item.state === 'failed' ? t('Click to open the log.') : t('Click to open the report.')}` : ''}`;
      if (opens) { row.classList.add('opens'); row.tabIndex = 0; row.setAttribute('role', 'button'); }
      return row;
    }));
    displayedBatch = signature;
  }
  // Each review's own time: final once done, counting up while it runs.
  for (const item of items) {
    const cell = $('batchItems').querySelector(`.batch-time[data-key="${CSS.escape(item.key)}"]`);
    if (!cell) continue;
    const seconds = item.state === 'running' && item.startedAt ? (Date.now() - Date.parse(item.startedAt)) / 1000 : item.duration;
    cell.textContent = known(seconds) ? duration(seconds) : item.state === 'queued' ? t('queued') : '';
  }
}
// A finished row opens its report in Reports & History, a failed one the log.
function openBatchRow(event) {
  const row = event.target.closest('.batch-item.opens');
  if (!row || event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  send('openBatchReport', { key: row.dataset.key });
}
$('batchItems').addEventListener('click', openBatchRow);
$('batchItems').addEventListener('keydown', openBatchRow);

function renderResults(run, id = 'results') {
  const panel = $(id);
  panel.replaceChildren();
  if (!run) return;
  // The General information heading already stands for a completed review.
  const label = run.status === 'completed' ? '' : { running: t('Review in progress…'), cancelling: t('Stopping review…'), cancelled: t('Review cancelled'),
    failed: t('Review failed'), interrupted: t('Review interrupted') }[run.status] || run.status;
  if (label) panel.append(element('div', label, `status ${['failed', 'interrupted'].includes(run.status) ? 'error' : ''}`));
  if (run.error) panel.append(element('p', run.error, 'message error'));
}

// Short local date and time, e.g. 16.10.26, 18:19, in the order of the language.
function shortDate(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  if (LANGUAGE !== 'en') return date.toLocaleString(LOCALE, { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const two = number => String(number).padStart(2, '0');
  return `${two(date.getDate())}.${two(date.getMonth() + 1)}.${two(date.getFullYear() % 100)}, ${two(date.getHours())}:${two(date.getMinutes())}`;
}

const ICONS = {
  person: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21a8 8 0 0 1 16 0'],
  branch: ['M6 3v12', 'M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 9a9 9 0 0 1-9 9'],
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); svg.append(path);
  }
  return svg;
}


// Gerrit patches: a change by URL, Waiting Review and In progress. The two
// lists come from one Gerrit refresh; each has its own filter.
const patchesStrip = document.querySelector('.patches-tabs');
const patchesTabs = [...patchesStrip.querySelectorAll('.folder-tab')];
const QUEUE_FILTERS = {
  waiting: [['ciFailed', t('Build or tests failed')], ['ciRunning', t('Build or tests still running')], ['plusOther', t('+1 from another reviewer')],
    ['negOther', t('−1 from another reviewer')], ['ready', t('Ready for landing')]],
  progress: [['noUpdates', t('No updates since my review')], ['mine', t('My +1 on this patchset')], ['ciFailed', t('Build or tests failed')],
    ['ciRunning', t('Build or tests still running')], ['ready', t('Ready for landing')], ['negOther', t('−1 from another reviewer')]],
};
const QUEUE_GROUPS = {
  waiting: ['ci', [['passed', t('CI passed')], ['running', t('CI running')], ['failed', t('CI failed')]]],
  progress: ['kind', [['newps', t('New patchset')], ['replied', t('Owner replied')], ['author', t('Waiting for author')], ['mine', t('My +1')]]],
};
// Collapsed groups are a per-view convenience, kept across reloads of the view.
const ui = { collapsed: {}, ...(vscode.getState() || {}) };
const saveUi = () => vscode.setState(ui);
let displayedQueue, displayedFilterOptions;
const queueTab = () => ['waiting', 'progress'].includes(state.patchesTab) ? state.patchesTab : undefined;
const hiddenKeys = tab => state.queueFilters?.[tab] || [];
const queueList = tab => state.queue?.[tab] || [];
const visibleQueue = tab => queueList(tab).filter(item => !hiddenKeys(tab).some(key => item[key]));
const freshItem = item => item.kind === 'newps' || item.kind === 'replied';

const QICONS = {
  cloudCheck: ['M7 18a5 5 0 1 1 .9-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 7.9', 'm9.5 15 2 2 4-4'],
  cloudUp: ['M7 18a5 5 0 1 1 .9-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 7.9', 'M12 19v-6', 'm9.5 15.5 2.5-2.5 2.5 2.5'],
  eyeOff: ['M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.2', 'M6.6 6.6C3.8 8.3 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6', 'M9.9 9.9a3 3 0 0 0 4.2 4.2', 'm3 3 18 18'],
  hash: ['M4 9h16', 'M4 15h16', 'M10 3 8 21', 'M16 3l-2 18'],
  ext: ['M14 4h6v6', 'M20 4l-9 9', 'M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5'],
  person: ICONS.person, branch: ICONS.branch,
  check: ['m5 12.5 4.5 4.5L19 7'], x: ['M6 6l12 12M18 6 6 18'], clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  reply: ['M9 14 4 9l5-5', 'M4 9h10a6 6 0 0 1 6 6v5'], layers: ['m12 3 9 5-9 5-9-5z', 'm3 13 9 5 9-5'],
  ai: ['M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z', 'M14 3v6h6', { d: 'M12 11.2l1.1 2.6 2.6 1.1-2.6 1.1-1.1 2.6-1.1-2.6-2.6-1.1 2.6-1.1z', fill: true }],
  lock: ['M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  ready: ['m2 12.5 4.5 4.5L16 7', 'm11 16 1 1 9.5-10'], chev: ['m9 6 6 6-6 6'],
  plus: ['M12 5v14', 'M5 12h14'], minus: ['M5 12h14'], dot: ['M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z'],
  coin: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.4 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-2-.5-2.5-1.5', 'M12 6.5v1.5', 'M12 16v1.5'],
  cpu: ['M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z', 'M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4'],
  gauge: ['M4 15a8 8 0 1 1 16 0', 'm12 15 4-5'], depth: ['M4 6h16', 'M7 11h10', 'M10 16h4'],
  file: ['M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z', 'M14 3v6h6'], msg: ['M4 5h16v11H8l-4 4z'],
  alert: ['M12 3 2 20h20z', 'M12 10v4', 'M12 17h.01'], sig: ['M4 17c3-4 5-9 7-9s0 9 3 9 3-4 6-4'],
  since: ['M3 12a9 9 0 1 0 3-6.7', 'M3 4v5h5'],
  link: ['M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1', 'M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1'],
  gear: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
  plug: ['M9 2v6', 'M15 2v6', 'M6 8h12v3a6 6 0 0 1-12 0z', 'M12 17v5'],
  refresh: ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  bot: ['M12 4v3', 'M7 7h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z', 'M9.5 12.5h.01', 'M14.5 12.5h.01', 'M9.5 16h5'],
};
function qicon(name, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  if (className) svg.setAttribute('class', className);
  for (const spec of QICONS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', typeof spec === 'string' ? spec : spec.d);
    if (spec.fill) { path.setAttribute('fill', 'currentColor'); path.setAttribute('stroke', 'none'); }
    svg.append(path);
  }
  return svg;
}
const voteWord = value => value > 0 ? `+${value}` : `−${-value}`;
const shortName = name => { const [first, last] = String(name || '').split(/\s+/); return last ? `${first} ${last[0]}.` : first || ''; };
// Compact age of a change event: 40m, 5h, 3d.
function age(value) {
  const minutes = Math.round((Date.now() - Date.parse(value)) / 60000);
  if (!Number.isFinite(minutes)) return '';
  return minutes < 60 ? t('{n}m', { n: Math.max(1, minutes) }) : minutes < 1440 ? t('{n}h', { n: Math.round(minutes / 60) }) : t('{n}d', { n: Math.round(minutes / 1440) });
}
function chip(label, className, iconName, title) {
  const node = element('span', undefined, `qchip ${className || ''}`.trim());
  if (iconName) node.append(qicon(iconName));
  node.append(document.createTextNode(label));
  if (title) node.title = title;
  return node;
}
function ciText(item) {
  const names = item.failedTests?.length ? `: ${item.failedTests.join(', ')}` : '';
  if (item.build === 'failed') return t('Build failed');
  if (item.build === 'running') return t('Build running');
  if (item.build === 'none' && item.ci !== 'passed') return t('Build not started');
  if (item.tests === 'failed') return `${t('Build passed · Tests failed')}${names}`;
  if (item.ci === 'failed') return t('Build passed · Verified −1');
  if (item.ci === 'running') return item.tests === 'none' ? t('Build passed · Tests not started') : t('Build passed · Tests running');
  return t('Build and tests passed');
}
const ciIcon = state => state === 'passed' ? 'check' : state === 'failed' ? 'x' : 'clock';
// One CI step as a chip: Build or Tests, running, not started or done.
function ciStep(kind, value, extra = '') {
  const text = kind === 'build' ? (value === 'running' ? t('Build running') : value === 'none' ? t('Build not started') : t('Build')) :
    value === 'running' ? t('Tests running') : value === 'none' ? t('Tests not started') : t('Tests');
  return chip(`${text}${extra}`, value === 'passed' ? 'ok' : value === 'failed' ? 'bad' : 'run', ciIcon(value));
}
function ciGlyph(item) {
  const glyph = element('span', undefined, `qci ${item.ci}`);
  glyph.append(qicon(ciIcon(item.ci)));
  glyph.setAttribute('aria-label', ciText(item));
  return glyph;
}
const reviewWord = item => item.myVote ? voteWord(item.myVote) : item.prior && item.myPs < item.ps ? voteWord(item.prior.value) : t('comments');
// The state of a change as chips: patchset, what changed since my review, owner reply, AI review.
function stateChips(item) {
  const chips = [];
  if (item.kind === 'newps') chips.push(chip(`PS ${item.myPs} → ${item.ps}`, 'newps', 'layers'));
  else chips.push(chip(`PS ${item.ps}`, 'ps'));
  if (item.replyAt) chips.push(chip(t('Owner {age}', { age: age(item.replyAt) }), 'replied', 'reply'));
  if (item.kind === 'author') chips.push(element('span', t('your {vote} · waiting', { vote: reviewWord(item) }), 'qtext'));
  if (item.kind === 'mine') chips.push(chip(t('+1 you'), 'ok'));
  if (item.published) chips.push(chip(t('AI posted'), 'muted', 'lock'));
  return chips;
}
// Someone else's AI review of the current patchset, in its own color.
const othersText = (item, review, author = review.author) => tn(review.count, '{author} already published an AI review of PS {ps} · {date} · [{signature}] · {n} comment',
  '{author} already published an AI review of PS {ps} · {date} · [{signature}] · {n} comments', { author, ps: item.ps, date: shortDate(review.at), signature: review.signature });
function othersChip(item, full) {
  const reviews = item.aiOthers || [];
  if (!reviews.length) return null;
  const more = reviews.length > 1 ? ` +${reviews.length - 1}` : '';
  const node = chip(full ? `${t('AI review by {author}', { author: reviews[0].author })}${more}` : `AI ${shortName(reviews[0].author)}${more}`, 'others', 'bot');
  node.setAttribute('aria-label', reviews.map(review => othersText(item, review)).join('. '));
  return node;
}
// Code-Review votes on the current patchset as slots: grey while empty, green
// for a positive vote, red for a negative one. Landing needs two +1, so there
// are always at least two slots.
function voteSlots(item, style) {
  const votes = [...item.votes].sort((a, b) => b.value - a.value);
  const node = element('span', undefined, `qvotes ${style}`);
  for (let index = 0; index < Math.max(2, votes.length); index++) {
    const vote = votes[index], kind = !vote ? 'empty' : vote.value > 0 ? 'plus' : 'minus';
    if (style === 'dots') { node.append(element('i', undefined, kind)); continue; }
    const slot = element('span', undefined, `qvote ${kind}`);
    slot.append(qicon(kind === 'minus' ? 'minus' : 'plus'));
    node.append(slot);
  }
  const needed = Math.max(0, 2 - votes.filter(vote => vote.value > 0).length);
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', `Code-Review: ${votes.length ? votes.map(vote => `${voteWord(vote.value)} ${vote.me ? t('you') : vote.name}`).join(', ') : t('no votes')}${needed ? `, ${tn(needed, '{n} more +1 needed', '{n} more +1 needed')}` : ''}`);
  return node;
}
function voteChips(item, named) {
  if (item.ready) return [chip(t('Ready to land'), 'ready', 'ready')];
  const others = item.votes.filter(vote => !vote.me);
  if (named) return others.map(vote => chip(`${voteWord(vote.value)} ${shortName(vote.name)}`, vote.value > 0 ? 'ok' : 'bad'));
  const plus = others.filter(vote => vote.value > 0), minus = others.filter(vote => vote.value < 0);
  return [plus.length ? chip(`+1${plus.length > 1 ? ` ×${plus.length}` : ''}`, 'ok') : null,
    minus.length ? chip(`−1${minus.length > 1 ? ` ×${minus.length}` : ''}`, 'bad') : null].filter(Boolean);
}
function owner(item, full) {
  const node = element('span', undefined, 'qowner');
  node.append(qicon('person'), element('span', full ? item.owner : shortName(item.owner)));
  return node;
}
function queueCheckbox(item) {
  const box = element('input', undefined, 'queue-check'); box.type = 'checkbox'; box.dataset.number = String(item.number);
  box.checked = !!item.selected || !!item.adding;
  const reason = state.busy ? t('Wait for the current review to finish before changing what to review.') :
    item.published ? t('PS {ps} already has a published AI review. A patchset gets one AI review.', { ps: item.ps }) :
    item.adding ? t('Reading the change from Gerrit…') : state.gerrit?.installed !== true ? t('Install gerrit-cli in AI Settings to review Gerrit changes.') : '';
  box.disabled = !!reason;
  box.title = reason || (item.selected ? t('Remove from the review') : t('Review PS {ps}', { ps: item.ps }));
  box.setAttribute('aria-label', t('Review change {number}: {subject}', { number: item.number, subject: item.subject }));
  box.addEventListener('change', () => send('queueSelect', { number: item.number, checked: box.checked }));
  return box;
}
function iconButton(name, label, className, action) {
  const button = element('button', undefined, `queue-icon ${className || ''}`.trim()); button.type = 'button';
  button.append(qicon(name)); button.title = label; button.setAttribute('aria-label', label);
  button.addEventListener('click', event => { event.stopPropagation(); action(); });
  return button;
}
const openButton = (item, className) => iconButton('ext', t('Open change {number} in Gerrit', { number: item.number }), className, () => send('openChange', { number: item.number }));
const aiButton = item => item.aiReady ? iconButton('ai', item.aiReady.here ? t('AI review of PS {ps} is ready, not published. Open it in Reports & History.', { ps: item.ps }) :
  t('AI review of PS {ps} is ready in another VS Code window, not published.', { ps: item.ps }), 'ai', () => send('openAiReview', { number: item.number })) : null;

// Hover details: the same colored chips as the cards, a little larger, so a
// narrow panel still shows everything about a change.
const queueTip = $('queueTip');
queueTip.setAttribute('role', 'tooltip');
// The details belong to one row, named by its key, so a list redrawn under a
// resting pointer keeps them on the same commit or change.
let tipTimer, tipRow;
function hideTip() { clearTimeout(tipTimer); queueTip.hidden = true; tipRow = undefined; }
const rowFor = row => row.isConnected ? row : row.dataset.tipKey && document.querySelector(`[data-tip-key="${CSS.escape(row.dataset.tipKey)}"]`);
function tipContent(item) {
  const title = element('div', undefined, 'tip-title');
  title.append(element('span', `#${item.number}`, 'tip-number'), element('span', item.subject, 'tip-subject'));
  const status = element('div', undefined, 'tip-row');
  status.append(...stateChips(item));
  if (item.kind === 'newps' && item.myPs) status.append(element('span', t('your {vote} was on PS {ps}', { vote: reviewWord(item), ps: item.myPs }), 'qtext'));
  if (item.kind === 'waiting') status.append(element('span', t('not reviewed yet'), 'qtext'));
  const ci = element('div', undefined, 'tip-row');
  ci.append(ciStep('build', item.build));
  if (item.build === 'passed') ci.append(ciStep('tests', item.tests, item.tests === 'failed' && item.failedTests?.length ? ` · ${item.failedTests.join(', ')}` : ''));
  if (item.ci === 'failed' && item.build !== 'failed' && item.tests !== 'failed') ci.append(chip('Verified −1', 'bad', 'x'));
  const votes = element('div', undefined, 'tip-row');
  votes.append(...item.votes.map(vote => chip(`${voteWord(vote.value)} ${vote.me ? t('you') : vote.name}`, vote.value > 0 ? 'ok' : 'bad')));
  if (item.ready) votes.append(chip(t('Ready for landing'), 'ready', 'ready'));
  if (!item.votes.length) votes.append(element('span', t('No Code-Review votes yet'), 'qtext'));
  const parts = [title, status, ci, votes];
  if (item.aiReady) parts.push(element('div', item.aiReady.here ? t('AI review of PS {ps} is ready to publish. Click its icon to open it.', { ps: item.ps }) :
    item.aiReady.folder ? t('AI review of PS {ps} is ready in another window: {folder}.', { ps: item.ps, folder: item.aiReady.folder }) :
    t('AI review of PS {ps} is ready in another window.', { ps: item.ps }), 'tip-line ai'));
  if (item.published) parts.push(element('div', `${t('AI review of PS {ps} published {date}', { ps: item.ps, date: shortDate(item.published.postedAt) })}.`, 'tip-line muted'));
  for (const review of item.aiOthers || []) {
    const line = element('div', undefined, 'tip-line others');
    line.append(qicon('bot'), element('span', `${othersText(item, review)}.`));
    parts.push(line);
  }
  const meta = element('div', undefined, 'tip-meta');
  meta.append(owner(item, true));
  if (item.branch) { const branch = element('span', undefined, 'qowner'); branch.append(qicon('branch'), element('span', item.branch)); meta.append(branch); }
  if (item.updated) meta.append(element('span', t('updated {date}', { date: shortDate(item.updated) })));
  if (item.unresolved) meta.append(element('span', tn(item.unresolved, '{n} unresolved', '{n} unresolved')));
  parts.push(meta);
  return parts;
}
function showTip(row, build, wide) {
  row = rowFor(row);
  if (!row) { hideTip(); return; }
  tipRow = row;
  queueTip.replaceChildren(...(row.tipBuild || build)());
  queueTip.classList.toggle('roomy', !!wide);
  queueTip.hidden = false;
  const box = row.getBoundingClientRect(), width = queueTip.offsetWidth, height = queueTip.offsetHeight;
  const left = Math.max(6, Math.min(box.left, window.innerWidth - width - 6));
  const below = box.bottom + 6, top = below + height <= window.innerHeight - 6 ? below : Math.max(6, box.top - height - 6);
  queueTip.style.left = `${left}px`; queueTip.style.top = `${top}px`;
}
function withTip(row, build, wide, key) {
  row.tipBuild = build;
  if (key) row.dataset.tipKey = key;
  row.addEventListener('mouseenter', () => { clearTimeout(tipTimer); tipTimer = setTimeout(() => showTip(row, build, wide), 350); });
  row.addEventListener('mouseleave', hideTip);
  row.addEventListener('focusin', () => showTip(row, build, wide));
  row.addEventListener('focusout', event => { if (!row.contains(event.relatedTarget)) hideTip(); });
  return row;
}
// After a list is redrawn: the same entry's fresh details, or none if it is gone.
function keepTip() {
  if (queueTip.hidden || !tipRow || tipRow.isConnected) return;
  const next = rowFor(tipRow);
  if (next) showTip(next, next.tipBuild, queueTip.classList.contains('roomy')); else hideTip();
}
// The pointer left the row: hide, even if the row was redrawn meanwhile and
// so never saw the pointer leave.
document.addEventListener('mousemove', event => {
  if (!queueTip.hidden && tipRow && !tipRow.contains(event.target)) hideTip();
});
document.addEventListener('scroll', hideTip, true);

// List: two lines per change, the kind of change as a colored left edge.
function listRow(item) {
  const row = withTip(element('li', undefined, `queue-row kind-${item.kind}${item.adding ? ' is-adding' : ''}`), () => tipContent(item), false, `change:${item.number}`);
  const main = element('div', undefined, 'queue-main');
  const first = element('div', undefined, 'queue-first');
  first.append(element('span', String(item.number), 'queue-number'), element('span', item.subject, 'queue-subject'));
  const second = element('div', undefined, 'queue-second');
  second.append(...stateChips(item), othersChip(item) || '', ciGlyph(item), voteSlots(item, 'plus'), owner(item));
  if (item.kind === 'waiting' && item.psCreated) second.append(element('span', age(item.psCreated), 'qtext'));
  main.append(first, second);
  const icons = element('div', undefined, 'queue-icons');
  icons.append(...[aiButton(item), openButton(item)].filter(Boolean));
  row.append(queueCheckbox(item), main, icons);
  return row;
}
// Cards: everything at a glance, with the same colored edge.
function cardRow(item) {
  const card = withTip(element('li', undefined, `queue-card kind-${item.kind}${item.adding ? ' is-adding' : ''}`), () => tipContent(item), false, `change:${item.number}`);
  const head = element('div', undefined, 'card-head');
  head.append(queueCheckbox(item), element('span', `#${item.number}`, 'card-number'));
  if (item.kind === 'newps') head.append(chip(`PS ${item.myPs} → ${item.ps}`, 'newps', 'layers'));
  else head.append(chip(`PS ${item.ps}`, 'ps'));
  if (item.replyAt) head.append(chip(item.kind === 'replied' ? t('Owner replied {age}', { age: age(item.replyAt) }) : age(item.replyAt), 'replied', 'reply'));
  if (item.kind === 'author') head.append(chip(t('Waiting for author'), ''));
  if (item.kind === 'mine') head.append(chip(t('+1 from you'), 'ok'));
  head.append(openButton(item));
  const meta = element('div', undefined, 'card-meta');
  meta.append(owner(item, true));
  if (item.branch) { const branch = element('span', undefined, 'qowner'); branch.append(qicon('branch'), element('span', item.branch)); meta.append(branch); }
  const when = item.kind === 'waiting' ? item.psCreated : item.updated;
  if (when) { const time = element('span', undefined, 'qowner'); time.append(qicon('clock'), element('span', age(when))); meta.append(time); }
  const foot = element('div', undefined, 'card-foot');
  foot.append(ciStep('build', item.build));
  if (item.build === 'passed') foot.append(ciStep('tests', item.tests, item.tests === 'failed' && item.failedTests?.length ? ` · ${item.failedTests[0]}` : ''));
  foot.append(voteSlots(item, 'plus'), ...voteChips(item, true));
  if (item.kind === 'newps' && item.prior?.value) foot.append(chip(t('your {vote} on PS {ps}', { vote: voteWord(item.prior.value), ps: item.myPs }), 'muted'));
  const others = othersChip(item, true); if (others) foot.append(others);
  card.append(head, element('div', item.subject, 'card-subject'), meta, foot);
  if (item.aiReady) {
    const ai = element('div', undefined, 'card-ai');
    const open = element('button', item.aiReady.here ? t('Open report') : t('Where?'), 'link'); open.type = 'button';
    open.addEventListener('click', () => send('openAiReview', { number: item.number }));
    ai.append(qicon('ai'), element('span', t('AI review of PS {ps} is ready', { ps: item.ps })), open);
    card.append(ai);
  }
  if (item.published) {
    const posted = element('div', undefined, 'card-posted');
    posted.append(qicon('lock'), element('span', t('AI review of PS {ps} published {date}', { ps: item.ps, date: shortDate(item.published.postedAt) })));
    card.append(posted);
  }
  return card;
}
// Groups: one line per change, under collapsible state headings.
function lineRow(item, tab) {
  const row = withTip(element('li', undefined, `queue-line${item.adding ? ' is-adding' : ''}`), () => tipContent(item), false, `change:${item.number}`);
  const mini = element('span', undefined, 'queue-mini');
  if (item.kind === 'newps' && item.replyAt) { const reply = element('span', undefined, 'qmark replied'); reply.append(qicon('reply')); mini.append(reply); }
  if (item.published) { const lock = element('span', undefined, 'qmark muted'); lock.append(qicon('lock')); mini.append(lock); }
  if (item.aiOthers?.length) {
    const bot = element('span', undefined, 'qmark others'); bot.append(qicon('bot'));
    bot.setAttribute('role', 'img'); bot.setAttribute('aria-label', item.aiOthers.map(review => othersText(item, review)).join('. '));
    mini.append(bot);
  }
  mini.append(ciGlyph(item), voteSlots(item, 'dots'));
  const ai = aiButton(item); if (ai) mini.append(ai);
  mini.append(openButton(item, 'reveal'));
  row.append(queueCheckbox(item), element('span', String(item.number), 'queue-number'), element('span', item.subject, 'queue-subject'), mini);
  return row;
}
function groupedList(items, tab) {
  const [key, groups] = QUEUE_GROUPS[tab], nodes = [];
  for (const [id, label] of groups) {
    const rows = items.filter(item => item[key] === id);
    if (!rows.length) continue;
    const name = `${tab}:${id}`, open = !ui.collapsed[name];
    const header = element('button', undefined, `queue-group group-${id}`); header.type = 'button';
    header.setAttribute('aria-expanded', String(open));
    header.append(qicon('chev', 'group-chev'), element('span', undefined, 'group-dot'), element('span', label), element('span', String(rows.length), 'group-count'));
    header.addEventListener('click', () => { ui.collapsed[name] = open; saveUi(); displayedQueue = undefined; renderPatches(); });
    nodes.push(header);
    if (open) { const list = element('ul', undefined, 'queue-items'); list.append(...rows.map(item => lineRow(item, tab))); nodes.push(list); }
  }
  return nodes;
}
// Hover details of a local commit: where it stands locally and on Gerrit.
function linkWords(commit) {
  const link = commit.gerrit || {};
  switch (link.state) {
    case 'current': return [`#${link.number} · PS ${link.ps}`, 'ok', t('On Gerrit as change {number}: patchset {ps} is this very commit.', { number: link.number, ps: link.ps })];
    case 'outdated': return [`#${link.number} · PS ${link.ps}`, 'orange', link.revision ?
      t('Gerrit has patchset {ps} ({revision}), not this commit: it was changed locally, or Gerrit holds another version.', { ps: link.ps, revision: link.revision.slice(0, 7) }) :
      t('Gerrit has patchset {ps}, not this commit: it was changed locally, or Gerrit holds another version.', { ps: link.ps })];
    case 'merged': return [`#${link.number} · ${t('merged')}`, 'blue', link.branch ? t('Merged on Gerrit as change {number} into {branch}.', { number: link.number, branch: link.branch }) :
      t('Merged on Gerrit as change {number}.', { number: link.number })];
    case 'abandoned': return [`#${link.number} · ${t('abandoned')}`, 'muted', t('Change {number} was abandoned on Gerrit.', { number: link.number })];
    case 'checking': return [t('Checking Gerrit…'), 'muted', t('Looking for this commit on Gerrit by its Change-Id.')];
    case 'unknown': return [t('Gerrit not checked'), 'muted', t('Could not check Gerrit yet. Check the Gerrit connection in AI Settings.')];
    default: return [t('Not on Gerrit'), 'muted', link.reason === 'changeId' ? t('This commit has no Change-Id, so it cannot be found on Gerrit.') :
      link.reason === 'project' ? t('This repository has no Gerrit project.') : t('No change on Gerrit has this commit’s Change-Id.')];
  }
}
function commitCard(commit) {
  const [label, tone, words] = linkWords(commit);
  const chips = element('div', undefined, 'tip-row');
  chips.append(chip(commit.shortSha, 'ps sha'), commit.merged ? chip(t('In {branch}', { branch: state.mergedBase }), 'blue', 'check') : chip(t('Not merged yet'), 'muted'), chip(label, tone, 'link'));
  const link = commit.gerrit || {};
  if (link.conflict) chips.append(chip(t('Merge conflict'), 'bad', 'alert'));
  const meta = element('div', undefined, 'tip-meta');
  meta.append(owner({ owner: commit.author }, true));
  const when = new Date(commit.date);
  if (!Number.isNaN(when.getTime())) { const time = element('span', undefined, 'qowner'); time.append(qicon('clock'), element('span', when.toLocaleString(LOCALE))); meta.append(time); }
  const branch = link.branch || state.mergedBase?.replace(/^[^/]+\//, '') || t('its branch');
  const conflict = link.conflict ? [element('div', link.state === 'current' ?
    t('Gerrit cannot merge patchset {ps} into {branch}. Rebase onto the latest {branch} and upload a new patchset.', { ps: link.ps, branch }) :
    t('Gerrit cannot merge patchset {ps} into {branch}. Once your local version is rebased onto the latest {branch}, upload it as a new patchset.', { ps: link.ps, branch }), 'tip-line bad')] : [];
  return [element('div', commit.subject, 'tip-subject'), chips, element('div', words, `tip-line ${tone}`), ...conflict, meta,
    element('div', commit.sha, 'tip-sha'), element('div', commit.gerrit?.number ? t('Click the subject to open the diff, the link to open Gerrit.') : t('Click the subject to open the diff.'), 'tip-hint')];
}
function emptyQueue(text) {
  const empty = element('div', undefined, 'history-empty queue-empty');
  const robot = element('span', undefined, 'ready-robot'); robot.setAttribute('aria-hidden', 'true');
  const face = element('span', undefined, 'robot-face'); face.append(element('i'), element('i'), element('b')); robot.append(face);
  empty.append(robot, element('span', text));
  return empty;
}

// A message with the buttons that fix what it describes. Rebuilt only when
// it changes, so a button keeps focus across background updates.
function setNotice(node, text, actions = [], error = false) {
  const signature = JSON.stringify([text, actions.map(action => action[0]), error]);
  node.hidden = !text;
  if (node.dataset.signature === signature) return;
  node.dataset.signature = signature;
  node.className = `hint notice${error ? ' error' : ''}`;
  node.replaceChildren(...(text ? [element('span', text, 'notice-text')] : []));
  if (!text || !actions.length) return;
  const row = element('span', undefined, 'notice-actions');
  for (const [label, type, iconName] of actions) {
    const button = element('button', undefined, 'notice-action'); button.type = 'button';
    button.append(qicon(iconName), element('span', label));
    button.addEventListener('click', () => send(type));
    row.append(button);
  }
  node.append(row);
}
const FIX = {
  utilities: [t('Open Utilities'), 'openUtilities', 'gear'],
  config: [t('Gerrit CLI configuration'), 'gerritConfig', 'file'],
  check: [t('Check connection'), 'checkGerrit', 'plug'],
  retry: [t('Retry'), 'refreshQueue', 'refresh'],
  repository: [t('Choose repository'), 'repository', 'folder'],
  installCli: [t('Install guide'), 'gerritHelp', 'ext'],
  installDashboard: [t('Install guide'), 'dashboardDownload', 'ext'],
};
// What the Gerrit CLI connection check found wrong, and how to fix it.
function gerritProblem() {
  switch (state.gerrit?.status) {
    case 'missing': return [t('Install gerrit-cli: it reads changes from Gerrit and publishes reviews with your account.'), [FIX.utilities, FIX.installCli]];
    case 'unconfigured': return [t('Gerrit CLI has no Gerrit account yet. Set GERRIT_USER and GERRIT_PASS (an HTTP password from Gerrit settings) in its configuration, then check the connection.'), [FIX.config, FIX.check]];
    case 'disconnected': return [t('Gerrit refused the Gerrit CLI login. Check GERRIT_USER and GERRIT_PASS in its configuration, then check the connection.'), [FIX.config, FIX.check]];
    case 'unavailable': return [t('Gerrit cannot be reached. Check your connection or VPN, then check again.'), [FIX.check]];
    case 'error': case 'unknown': return [t('Could not check the Gerrit connection.'), [FIX.check, FIX.config]];
    default: return undefined;
  }
}
function queueProblem(queue) {
  switch (queue.errorCode) {
    case 'account': return [queue.error, [FIX.config, FIX.check]];
    case 'gerrit': return [queue.error, [FIX.check, FIX.config, FIX.retry]];
    case 'timeout': return [queue.error, [FIX.retry, FIX.check]];
    case 'dashboard': return [queue.error, [FIX.utilities, FIX.installDashboard]];
    default: return [queue.error, [FIX.retry]];
  }
}

function renderFilterMenu(tab) {
  const hidden = new Set(hiddenKeys(tab)), items = queueList(tab);
  const signature = JSON.stringify([tab, items.map(item => QUEUE_FILTERS[tab].map(([key]) => !!item[key]))]);
  if (signature !== displayedFilterOptions) {
    $('queueFilterOptions').replaceChildren(...QUEUE_FILTERS[tab].map(([key, label]) => {
      const row = element('label', undefined, 'queue-filter-option');
      const box = element('input'); box.type = 'checkbox'; box.dataset.key = key;
      box.addEventListener('change', () => {
        const next = [...$('queueFilterOptions').querySelectorAll('input')].filter(input => !input.checked).map(input => input.dataset.key);
        state.queueFilters = { ...state.queueFilters, [tab]: next };
        send('queueFilters', { tab, hidden: next });
        renderPatches();
      });
      row.append(box, element('span', label), element('span', String(items.filter(item => item[key]).length), 'queue-filter-n'));
      return row;
    }));
    displayedFilterOptions = signature;
  }
  for (const box of $('queueFilterOptions').querySelectorAll('input')) box.checked = !hidden.has(box.dataset.key);
  const count = items.length - visibleQueue(tab).length, defaults = state.queueDefaults?.[tab] || [];
  $('queueFilterHidden').textContent = count ? tn(count, '{n} hidden', '{n} hidden') : t('Nothing hidden');
  $('queueFilterReset').disabled = hidden.size === defaults.length && defaults.every(key => hidden.has(key));
}
function closeFilter(focus) {
  if ($('queueFilterMenu').hidden) return;
  $('queueFilterMenu').hidden = true;
  $('queueFilter').setAttribute('aria-expanded', 'false');
  if (focus) $('queueFilter').focus();
}
on('queueFilter', 'click', event => {
  event.stopPropagation();
  const open = $('queueFilterMenu').hidden;
  if (!open) { closeFilter(); return; }
  closeView();
  $('queueFilterMenu').hidden = false;
  $('queueFilter').setAttribute('aria-expanded', 'true');
  renderFilterMenu(queueTab());
  $('queueFilterOptions').querySelector('input')?.focus({ preventScroll: true });
});
$('queueFilterMenu').addEventListener('click', event => event.stopPropagation());
$('queueFilterMenu').addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); closeFilter(true); } });
document.addEventListener('click', () => closeFilter());
const setFilter = hidden => {
  const tab = queueTab(); if (!tab) return;
  state.queueFilters = { ...state.queueFilters, [tab]: hidden };
  send('queueFilters', { tab, hidden });
  renderPatches();
};
on('queueFilterReset', 'click', () => setFilter([...(state.queueDefaults?.[queueTab()] || [])]));
on('queueShowAll', 'click', () => setFilter([]));
on('queueRefresh', 'click', () => send('refreshQueue'));
// The eye button beside the filter chooses how the lists look.
const LAYOUT_NAMES = { list: t('List'), cards: t('Cards'), groups: t('Groups') };
const currentLayout = () => Object.hasOwn(LAYOUT_NAMES, state.patchesLayout) ? state.patchesLayout : 'list';
const viewItems = [...$('queueViewMenu').querySelectorAll('[data-layout]')];
function renderViewMenu() {
  for (const item of viewItems) {
    const chosen = item.dataset.layout === currentLayout();
    item.setAttribute('aria-checked', String(chosen));
    item.tabIndex = chosen ? 0 : -1;
  }
  $('queueView').title = t('View: {name}. Choose how the list looks.', { name: LAYOUT_NAMES[currentLayout()] });
  $('queueView').setAttribute('aria-label', t('View: {name}', { name: LAYOUT_NAMES[currentLayout()] }));
}
function closeView(focus) {
  if ($('queueViewMenu').hidden) return;
  $('queueViewMenu').hidden = true;
  $('queueView').setAttribute('aria-expanded', 'false');
  if (focus) $('queueView').focus();
}
on('queueView', 'click', event => {
  event.stopPropagation();
  if (!$('queueViewMenu').hidden) { closeView(); return; }
  closeFilter();
  renderViewMenu();
  $('queueViewMenu').hidden = false;
  $('queueView').setAttribute('aria-expanded', 'true');
  $('queueViewMenu').querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
});
$('queueViewMenu').addEventListener('click', event => event.stopPropagation());
$('queueViewMenu').addEventListener('keydown', event => {
  const index = viewItems.indexOf(document.activeElement);
  const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: viewItems.length - 1 }[event.key];
  if (next !== undefined) { event.preventDefault(); viewItems[(next + viewItems.length) % viewItems.length].focus(); }
  if (event.key === 'Escape') { event.stopPropagation(); closeView(true); }
  if (event.key === 'Tab') closeView();
});
for (const item of viewItems) item.addEventListener('click', () => {
  state.patchesLayout = item.dataset.layout;
  closeView(true);
  send('patchesLayout', { value: item.dataset.layout });
  renderPatches();
});
document.addEventListener('click', () => closeView());

function queueClock() {
  const queue = state.queue || {};
  $('queueUpdated').textContent = queue.refreshing ? queue.loaded ? t('Refreshing…') : t('Loading from Gerrit…') : !queue.refreshedAt ? t('Not loaded yet') : (() => {
    const minutes = Math.round((Date.now() - Date.parse(queue.refreshedAt)) / 60000);
    return minutes < 1 ? t('Updated just now') : minutes < 60 ? t('Updated {n} min ago', { n: minutes }) : minutes < 1440 ? t('Updated {n} h ago', { n: Math.round(minutes / 60) }) :
      t('Updated {date}', { date: shortDate(queue.refreshedAt) });
  })();
  $('queueUpdated').title = queue.refreshedAt ? `${t('Last refresh: {date}', { date: new Date(queue.refreshedAt).toLocaleString(LOCALE) })}${queue.account ? ` · ${queue.account}` : ''}` : '';
}
setInterval(() => { if (queueTab()) queueClock(); }, 15000);

function renderQueue(tab) {
  const queue = state.queue || {}, patches = state.gerritPatches || {};
  queueClock();
  const blocked = !state.repository || queue.projectError || queue.installed !== 'installed';
  // Nothing to refresh or filter until the list can be read.
  document.querySelector('.queue-toolbar').hidden = !!blocked;
  $('queueRefresh').disabled = !!blocked || !!queue.refreshing;
  $('queueRefresh').classList.toggle('spinning', !!queue.refreshing);
  const all = queueList(tab), shown = visibleQueue(tab), hidden = all.length - shown.length;
  $('queueFilter').dataset.on = String(hiddenKeys(tab).length > 0);
  $('queueFilterCount').hidden = !hidden;
  $('queueFilterCount').textContent = String(hidden);
  $('queueFilter').setAttribute('aria-label', hidden ? t('Filter the list: {n} hidden', { n: hidden }) : t('Filter the list'));
  if (!$('queueFilterMenu').hidden) renderFilterMenu(tab);
  renderViewMenu();
  // One message at a time: what blocks the list first, then a failed refresh,
  // then a change that could not be added for review.
  const message = $('queueMessage'), problem = gerritProblem();
  if (!state.repository) setNotice(message, t('Choose a Git repository in Local commits.'), [FIX.repository]);
  else if (queue.projectError) setNotice(message, queue.projectError, [FIX.repository]);
  else if (queue.installed === 'missing') setNotice(message, t('Install gerrit-dashboard to list the changes where you are a reviewer.'), [FIX.utilities, FIX.installDashboard]);
  // A connection check that already failed says so before any refresh does.
  else if (problem) setNotice(message, ...problem);
  else if (queue.error) setNotice(message, ...queueProblem(queue), true);
  else if (patches.error && patches.change) setNotice(message, patches.message, [], true);
  else if (state.busy) setNotice(message, t('Wait for the current review to finish before changing what to review.'));
  else setNotice(message, '');
  const layout = currentLayout();
  const signature = JSON.stringify([tab, layout, shown, all.length, queue.loaded, queue.refreshing, !!blocked, state.busy, state.gerrit?.installed, ui.collapsed]);
  if (signature !== displayedQueue) {
    // A rebuilt list keeps keyboard focus on the same change's checkbox.
    const focused = document.activeElement?.classList?.contains('queue-check') ? document.activeElement.dataset.number : undefined;
    let nodes;
    if (blocked) nodes = [];
    else if (!queue.loaded) nodes = queue.refreshing ? [element('p', t('Reading your reviews from Gerrit. This takes a few seconds…'), 'hint queue-loading')] :
      queue.error ? [] : [element('p', t('Not loaded yet. Refresh to read the changes where you are a reviewer.'), 'hint')];
    else if (!all.length) nodes = [emptyQueue(tab === 'waiting' ? t('Nothing is waiting for your review') : t('No reviews in progress'))];
    else if (!shown.length) nodes = [emptyQueue(tn(all.length, '{n} change is hidden by the filter', 'All {n} changes are hidden by the filter'))];
    else if (layout === 'groups') nodes = groupedList(shown, tab);
    else { const list = element('ul', undefined, layout === 'cards' ? 'queue-cards' : 'queue-items'); list.append(...shown.map(layout === 'cards' ? cardRow : listRow)); nodes = [list]; }
    $('queueList').replaceChildren(...nodes);
    $('queueList').dataset.layout = layout;
    if (focused) $('queueList').querySelector(`.queue-check[data-number="${focused}"]`)?.focus();
    displayedQueue = signature;
    keepTip();
  }
  $('queueHiddenNote').hidden = !hidden || !queue.loaded || !!blocked;
  $('queueHiddenText').textContent = tn(hidden, '{n} hidden by filter', '{n} hidden by filter');
}

function renderPatches() {
  const tab = ['url', 'waiting', 'progress'].includes(state.patchesTab) ? state.patchesTab : 'url';
  const queue = state.queue || {};
  for (const button of patchesTabs) {
    const selected = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  // Waiting Review counts the changes shown; In progress, those updated since my review.
  const waiting = visibleQueue('waiting'), progress = visibleQueue('progress'), fresh = progress.filter(freshItem).length;
  $('waitingTabCount').textContent = String(waiting.length);
  $('waitingTabCount').hidden = !queue.loaded;
  $('progressTabCount').textContent = String(fresh);
  $('progressTabCount').hidden = !queue.loaded || !fresh;
  $('patchesTab-waiting').title = `${$('patchesTab-waiting').dataset.tip}${queue.loaded ? `\n${t('{shown} shown of {total}.', { shown: waiting.length, total: queueList('waiting').length })}` : ''}`;
  $('patchesTab-progress').title = `${$('patchesTab-progress').dataset.tip}${queue.loaded ? `\n${t('{fresh} updated since your review · {shown} shown of {total}.', { fresh, shown: progress.length, total: queueList('progress').length })}` : ''}`;
  $('patchesTab-waiting').setAttribute('aria-label', `${t('Waiting Review')}${queue.loaded ? `: ${waiting.length}` : ''}`);
  $('patchesTab-progress').setAttribute('aria-label', `${t('In progress')}${queue.loaded ? `: ${t('{n} updated', { n: fresh })}` : ''}`);
  for (const page of document.querySelectorAll('.patches-page')) page.hidden = (page.dataset.page === 'url') !== (tab === 'url');
  $('patchesPanel').setAttribute('aria-labelledby', `patchesTab-${tab}`);
  if (tab === 'url') { closeFilter(); closeView(); if (tipRow?.closest('#queueList')) hideTip(); } else renderQueue(tab);
  fitStrip(patchesStrip);
}
patchesTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => {
    if (state.patchesTab === tab.dataset.tab) return;
    state.patchesTab = tab.dataset.tab;
    closeFilter(); closeView();
    renderPatches();
    send('patchesTab', { value: tab.dataset.tab });
  });
  tab.addEventListener('keydown', event => {
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: patchesTabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = patchesTabs[(next + patchesTabs.length) % patchesTabs.length];
    target.focus(); target.click();
  });
});
function renderDashboard() {
  const entry = state.gerritDashboard || {};
  $('dashboardStatus').textContent = installedText(entry, '');
  $('dashboardStatus').className = `connection-status connection-${entry.installed ? 'connected' : entry.status === 'missing' ? 'missing' : 'checking'}`;
  $('dashboardPath').textContent = entry.path || (entry.status === 'missing' ? t('Optional. Needed only for Waiting Review and In progress. Install it beside lreview or set Lustre Review: Gerrit Dashboard Path.') : '');
  $('dashboardDownload').hidden = entry.status !== 'missing';
}

// General information: the report's change and its state on Gerrit, what the
// review found and where, and what the run cost.
const FINDING_KINDS = FINDING_ORDER.map(key => [key]);
const commitFile = file => ['/COMMIT_MSG', 'COMMIT_MSG', 'COMMIT_MESSAGE'].includes(file) ? '/COMMIT_MSG' : file;
const findingKind = message => String(message || '').match(/^\s*(?:\*\*)?\((defect|minor|suggestion|typo|style|nit)\)/i)?.[1]?.toLowerCase() || 'other';
function findingFiles(run) {
  const files = new Map();
  for (const comment of run.results?.[0]?.comments || []) {
    const file = commitFile(comment.file);
    if (!files.has(file)) files.set(file, []);
    files.get(file).push(findingKind(comment.message));
  }
  return [...files].sort(([a], [b]) => (a === '/COMMIT_MSG') - (b === '/COMMIT_MSG'));
}
function linkChip(link) {
  switch (link?.state) {
    case 'current': return chip(`#${link.number} · PS ${link.ps}`, 'ok', 'link', t('On Gerrit: the change holds this very commit.'));
    case 'outdated': return chip(`#${link.number} · ${t('PS {ps} differs', { ps: link.ps })}`, 'orange', 'link', t('Gerrit holds another version of this commit.'));
    case 'merged': return chip(`#${link.number} · ${t('merged')}`, 'blue', 'link');
    case 'abandoned': return chip(`#${link.number} · ${t('abandoned')}`, 'muted', 'link');
    case 'checking': return chip(t('Checking Gerrit…'), 'muted');
    case 'unknown': return chip(t('Gerrit not checked'), 'muted');
    default: return chip(link?.reason === 'changeId' ? t('No Change-Id') : t('Not on Gerrit'), 'muted', 'link');
  }
}
function renderHistoryStats(run, id = 'historyStats') {
  const panel = $(id); panel.replaceChildren(); panel.hidden = !run;
  panel.classList.remove('outdated');
  if (!run) return;
  const summary = run.summary || {}, live = run.gerritState || {}, patch = run.gerritPatch;
  const files = findingFiles(run), changed = new Set(live.changed || []);
  const newer = live.kind === 'gerrit' && live.current > live.reviewed;
  // Stale only when the newer patchset touches a file the review commented on.
  const touched = newer ? files.map(([file]) => file).filter(file => changed.has(file)) : [];
  panel.classList.toggle('outdated', touched.length > 0);

  const top = element('div', undefined, 'rc-sec rc-top');
  const number = live.kind === 'gerrit' ? live.number : live.link?.number;
  if (number) {
    const tone = live.kind === 'gerrit' ? (live.status === 'MERGED' ? 'merged' : touched.length ? 'outdated' : 'current') : live.link.state;
    const conflict = live.kind === 'gerrit' ? live.conflict : live.link?.conflict;
    const open = element('button', undefined, `rc-link link-${tone}${conflict && tone === 'current' ? ' link-conflict' : ''}`); open.type = 'button';
    open.append(qicon('link'));
    open.title = t('Open change {number} on Gerrit', { number }); open.setAttribute('aria-label', open.title);
    open.addEventListener('click', () => send('openReportChange', { id: run.id }));
    top.append(open);
  }
  top.append(element('div', summary.commits?.length === 1 ? summary.commits[0].subject : run.subjects?.map(item => item.subject).join(' / ') || '', 'rc-subject'));
  const strip = element('div', undefined, 'rc-strip');
  const place = (iconName, text, title) => { const node = element('span', undefined, 'qowner'); node.append(qicon(iconName), element('span', text)); if (title) node.title = title; return node; };
  if (patch) {
    strip.append(chip(`#${patch.number}`, 'blue'));
    if (newer) strip.append(chip(`PS ${live.reviewed} → ${live.current}`, touched.length ? 'orange' : 'muted', 'layers',
      touched.length ? t('The newer patchset changes a file with findings.') : live.changed ? t('The newer patchset leaves the files with findings alone.') : t('Checking which files the newer patchset changed…')));
    else strip.append(chip(`PS ${patch.patchset}`, 'ps'));
    if (live.status === 'MERGED') strip.append(chip(t('Merged'), 'blue', 'check'));
    if (live.conflict) strip.append(chip(t('Merge conflict'), 'bad', 'alert', t('Gerrit cannot merge PS {ps} into {branch}: it needs a rebase.', { ps: live.current || patch.patchset, branch: patch.branch || t('its branch') })));
    if (live.status === 'ABANDONED') strip.append(chip(t('Abandoned'), 'muted'));
    if (live.replyAt) strip.append(chip(t('Owner {age}', { age: age(live.replyAt) }), 'replied', 'reply', t('The owner replied {date}', { date: shortDate(live.replyAt) })));
    if (patch.owner) strip.append(place('person', patch.owner, t('Change owner')));
    if (patch.branch) strip.append(place('branch', patch.branch, t('Target branch: {branch}', { branch: patch.branch })));
  } else {
    strip.append(chip(String(live.sha || run.reportSha || '').slice(0, 7), 'ps sha'), linkChip(live.link));
    if (live.link?.conflict) strip.append(chip(t('Merge conflict'), 'bad', 'alert', t('Gerrit cannot merge PS {ps} into {branch}: rebase and upload a new patchset.', { ps: live.link.ps, branch: live.link.branch || t('its branch') })));
    if (run.since) strip.append(chip(t('since {sha}', { sha: run.since.slice(0, 7) }), 'blue', 'since', t('Reviewed only what changed since {sha}', { sha: run.since })));
  }
  top.append(strip);
  if (touched.length) {
    const note = element('div', undefined, 'rc-note');
    const names = touched.map(file => file === '/COMMIT_MSG' ? t('the commit message') : file);
    note.append(qicon('alert'), element('span', t('PS {ps} changes {files}, where this review found issues. Review PS {ps} before publishing.', { ps: live.current, files: names.join(', ') })));
    top.append(note);
  }
  const rows = element('div', undefined, 'rc-rows');
  const row = label => { const node = element('div', undefined, 'rc-row'); node.append(element('span', label, 'rc-label')); return node; };
  if (live.build) {
    const gerrit = row('Gerrit');
    gerrit.append(ciStep('build', live.build));
    if (live.build === 'passed') gerrit.append(ciStep('tests', live.tests, live.tests === 'failed' && live.failedTests?.length ? ` · ${live.failedTests[0]}` : ''));
    gerrit.append(voteSlots({ votes: live.votes || [] }, 'plus'));
    rows.append(gerrit);
  } else if (live.loading && (patch || live.link?.number)) {
    const gerrit = row('Gerrit'); gerrit.append(element('span', t('Checking Gerrit…'), 'qtext')); rows.append(gerrit);
  }
  const counts = summary.findings;
  if (counts) {
    const found = row(t('Found'));
    const kinds = FINDING_KINDS.filter(([key]) => counts[key] > 0);
    const words = element('span', undefined, 'rc-words'), dots = element('span', undefined, 'rc-dots');
    for (const [key] of kinds) {
      const label = `${counts.partial ? '≥ ' : ''}${findingText(key, counts[key])}`;
      words.append(chip(label, `find kind-${key}`));
      const dot = element('span', undefined, `kind-${key}`); dot.title = label; dot.append(element('i'), document.createTextNode(String(counts[key]))); dots.append(dot);
    }
    if (counts.commitMessage) {
      words.append(chip(t('{n} in commit msg', { n: counts.commitMessage }), 'muted', 'msg'));
      const message = element('span'); message.title = t('{n} in the commit message', { n: counts.commitMessage }); message.append(qicon('msg'), document.createTextNode(String(counts.commitMessage))); dots.append(message);
    }
    if (!kinds.length) words.append(chip(t('No findings'), 'ok', 'check'));
    found.append(words, dots);
    rows.append(found);
  }
  if (rows.childNodes.length) top.append(rows);
  panel.append(top);

  if (files.length) {
    const section = element('div', undefined, 'rc-sec');
    section.append(element('span', t('Files with findings'), 'rc-caption'));
    const list = element('ul', undefined, 'rc-files');
    const active = activeStatus(run.status);
    for (const [file, kinds] of files) {
      const item = element('li'), open = element('button', undefined, 'rc-file'); open.type = 'button';
      const name = file === '/COMMIT_MSG' ? t('Commit message') : file;
      open.append(qicon(file === '/COMMIT_MSG' ? 'msg' : 'file'), element('span', name, 'rc-path'));
      if (touched.includes(file)) open.append(element('span', t('changed in PS {ps}', { ps: live.current }), 'rc-changed'));
      const marks = element('span', undefined, 'rc-marks'); marks.append(...kinds.map(kind => element('i', undefined, `kind-${kind}`))); open.append(marks);
      open.title = tn(kinds.length, '{file}: {n} finding. Open its diff with the review comments.', '{file}: {n} findings. Open its diff with the review comments.', { file: name });
      open.disabled = active;
      open.addEventListener('click', () => send('reviewDiffFile', { id: run.id, file }));
      item.append(open); list.append(item);
    }
    section.append(list); panel.append(section);
  }

  const facts = element('div', undefined, 'rc-sec');
  const line = element('div', undefined, 'rc-facts'), quiet = element('div', undefined, 'rc-facts quiet');
  const fact = (kind, iconName, text, title) => { const node = element('span', undefined, `fact-${kind}`); node.append(qicon(iconName), element('span', text)); if (title) node.title = title; return node; };
  line.append(fact('time', 'clock', known(summary.elapsed) ? duration(summary.elapsed) : '—', run.commits?.length > 1 ? t('Batch elapsed') : t('Elapsed')));
  const cost = known(summary.cost) ? `${summary.costPartial ? '≥ ' : ''}$${summary.cost.toFixed(2)}` :
    known(summary.credits) ? tn(summary.credits, '{n} credit', '{n} credits', { n: formatNumber(summary.credits) }) : '—';
  // The label comes in English: API estimate, Est. cost or Cost.
  line.append(fact('cost', 'coin', cost, t(summary.costLabel || 'Cost')));
  line.append(fact('tokens', 'layers', `${known(summary.tokens) && summary.tokenPartial ? '≥ ' : ''}${compactTokens(summary.tokens)}`,
    known(summary.tokens) ? tokenCount(summary.tokens, summary.tokenPartial) : t('Tokens not reported.')));
  line.append(fact('model', 'cpu', `${agentName(run.agent)} · ${run.modelName || run.model || '—'}`, t('Agent and model')));
  line.append(fact('reasoning', 'gauge', run.effort || t('Default'), t('Reasoning')));
  line.append(fact('depth', 'depth', run.mode === 'light' ? t('Light') : t('Full'), t('Review depth')));
  if (run.signature) quiet.append(fact('quiet', 'sig', run.signature, t('Signature')));
  quiet.append(fact('quiet', 'clock', shortDate(run.startedAt), t('Started')));
  facts.append(line, quiet);
  if (summary.findings?.partial) facts.append(element('p', t('Partial results: counts include only completed commits.'), 'hint'));
  if (!summary.findings) facts.append(element('p', t('Finding counts are unavailable: this review has no completed result.'), 'hint'));
  if (summary.costLabel?.includes('estimate') || summary.costLabel === 'Est. cost') facts.append(element('p', t('Estimated API cost, not a subscription charge.'), 'hint'));
  panel.append(facts);
}

const activeStatus = status => ['running', 'cancelling'].includes(status);

function renderPublish() {
  const run = state.gerritRun, publication = run?.publication;
  // Another review, in this window or another, already published this
  // patchset. A patchset gets one AI review, so this one counts as published.
  const shared = publication?.status !== 'posted' ? run?.sharedPublication : undefined;
  const status = shared ? 'posted' : publication?.status;
  const blocked = !run ? t('Choose a Gerrit review.') : shared ? (shared.signature ? t('Already published by another review as {signature}.', { signature: shared.signature }) : t('Already published by another review.')) :
    !state.lreview?.installed ? t('Install lreview in AI Settings.') :
    !state.gerrit?.installed ? t('Install gerrit-cli in AI Settings.') :
    !['ready', 'error'].includes(status) ? publication?.message || t('Checking saved review…') : '';
  if (blocked) unlockedPublish = undefined;
  const unlocked = !blocked && unlockedPublish === run.id;
  const lock = $('publishLock');
  lock.hidden = ['posted', 'publishing'].includes(status);
  lock.disabled = !!blocked;
  lock.setAttribute('aria-pressed', String(unlocked));
  lock.setAttribute('aria-label', unlocked ? t('Lock Publish to Gerrit') : t('Unlock Publish to Gerrit'));
  lock.title = blocked || (unlocked ? t('Lock publishing again.') : t('Unlock to publish this review to Gerrit.'));
  const postedAt = shortDate(shared ? shared.postedAt : publication?.postedAt);
  $('publishGerrit').textContent = status === 'posted' ? (postedAt ? t('Published {date}', { date: postedAt }) : t('Published')) : status === 'publishing' ? t('Publishing…') : t('Publish to Gerrit');
  $('publishGerrit').disabled = !unlocked;
  $('publishGerrit').title = shared ? blocked : status === 'posted' ? publication.message : blocked || (unlocked ? publication.message : t('Unlock first to publish.'));
  $('publishGroup').classList.toggle('unavailable', !!blocked);
  $('sharedPublication').hidden = !shared;
  $('sharedPublication').textContent = !shared ? '' : shared.signature ?
    t('PS {ps} was already published {date} by another review as {signature}. A patchset gets one AI review.', { ps: run.gerritPatch.patchset, date: shortDate(shared.postedAt), signature: shared.signature }) :
    t('PS {ps} was already published {date} by another review. A patchset gets one AI review.', { ps: run.gerritPatch.patchset, date: shortDate(shared.postedAt) });
  // Someone else's AI review of this patchset: a warning, never a block.
  const others = run?.otherAiReviews || [];
  $('otherAiReviews').hidden = !others.length;
  $('otherAiReviews').replaceChildren(...others.map(review => element('p',
    `${othersText({ ps: run.gerritPatch.patchset }, review, review.mine ? t('Your account') : review.author)}.`)));
  // The button itself says Published; the hint explains only what needs attention.
  $('publicationStatus').hidden = !publication?.message || !['error', 'unknown', 'unavailable'].includes(status);
  $('publicationStatus').textContent = publication?.message || '';
  $('publicationStatus').className = `hint ${['error', 'unknown'].includes(status) ? 'error' : ''}`;
}

function renderDiffButton(tab, run) {
  const id = `${tab}Diff`, git = state.git || {};
  const blocked = !run ? t('Choose a review.') : activeStatus(run.status) ? t('Wait for the review to finish.') :
    !['clean', 'findings'].includes(run.results?.[0]?.status) ? t('This review has no completed result to compare.') :
    git.status === 'outdated' ? t('Update Git to {version} or newer in AI Settings.', { version: git.minimum }) :
    git.status === 'missing' ? t('Install Git in AI Settings to open review diffs.') : !git.installed ? t('Checking Git…') : '';
  const files = commentedFiles(run), scope = diffScope(run);
  $(id).disabled = !!blocked;
  $(`${id}Menu`).disabled = !!blocked;
  if (blocked) closeDiffMenus();
  $(`${id}Tip`).textContent = blocked || (scope === 'commented' ? tn(files, 'Open the diff: {n} file with comments.', 'Open the diff: {n} files with comments.') :
    files ? t('Open the diff: all changed files.') : t('Open the diff: all changed files (no comments).'));
  // Disabled buttons cannot take focus; let keyboard users reach the reason.
  $(id).parentElement.tabIndex = blocked ? 0 : -1;
  $(`${id}Count`).textContent = String(files);
  for (const item of $(`${id}Options`).querySelectorAll('button')) {
    item.setAttribute('aria-checked', String(item.dataset.scope === scope));
    item.disabled = item.dataset.scope === 'commented' && !files;
    item.title = item.disabled ? t('This review has no comments.') : '';
  }
}

// Reports & History: a list per tab instead of a native select. Gerrit
// reviews are grouped by change, local ones by commit with all its versions
// (by Change-Id). Search, quick filters and, on Gerrit, the branches the
// reviews are for narrow it. A review opens on click; a group opens its reviews.
ui.history ||= {};
const historyPrefs = tab => (ui.history[tab] ||= { filter: 'all', hideOld: false, hidePublished: false, branch: '' });
// Gerrit: a patchset that already has a published AI review, from this review or another.
const historyPublished = row => !!row.gerrit && (row.gerrit.published || row.gerrit.publishedElsewhere);
let historyOpen = false, historyQuery = '', historyActive, displayedHistoryList, displayedHistoryChosen;
const historyTabKey = () => state.historyTab === 'gerrit' ? 'gerrit' : 'local';
const historyRows = () => (historyTabKey() === 'gerrit' ? state.gerritHistory : state.history) || [];
const chosenHistoryId = () => (historyTabKey() === 'gerrit' ? state.gerritRun : state.run)?.id;
const HISTORY_OK = ['clean', 'findings'];
const historyOutcome = row => HISTORY_OK.includes(row.result) ? row.result : activeStatus(row.status) ? 'running' :
  ['cancelled', 'interrupted'].includes(row.status) ? 'cancelled' : 'failed';
// Outdated: a review of a patchset Gerrit moved on from, or of a commit version Gerrit no longer has.
const historyOutdated = row => row.gerrit ? row.gerrit.current > row.gerrit.ps : row.local?.link?.state === 'outdated';
const historyGroupKey = row => row.gerrit ? `c${row.gerrit.change}` : `i${row.local?.changeId || row.local?.sha || row.id}`;
const HISTORY_LINK = { current: 'link-current', outdated: 'link-outdated' };
function historyWhen(value, withTime = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const two = n => String(n).padStart(2, '0'), time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  // Today: the time; before: the date.
  if (date.toDateString() === new Date().toDateString()) return time;
  const day = date.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
  return withTime ? `${day} ${time}` : day;
}
// Gerrit: the newest successful review of each patchset, not published yet.
function historyToPublish(rows) {
  const seen = new Set(), ids = new Set();
  for (const row of rows) {
    if (!row.gerrit || !HISTORY_OK.includes(row.result)) continue;
    const key = `${row.gerrit.change}:${row.gerrit.ps}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!row.gerrit.published && !row.gerrit.publishedElsewhere) ids.add(row.id);
  }
  return ids;
}
function historyMatches(row, query) {
  const text = query.trim().toLowerCase();
  if (!text) return true;
  // A change number, #number or Gerrit URL finds that change.
  const number = /(?:^#?|\/)(\d{3,})\/?(?:\d+)?\/?$/.exec(text)?.[1];
  if (number && row.gerrit && String(row.gerrit.change) === number) return true;
  return [row.gerrit && `#${row.gerrit.change}`, row.local?.sha, row.subject, row.model, row.gerrit?.branch, ...(row.tickets || [])]
    .filter(Boolean).join(' ').toLowerCase().includes(text);
}
const historyFindings = row => FINDING_KINDS.filter(([key]) => row.kinds?.[key]).map(([key]) => [key, findingText(key, row.kinds[key])]);
// A review's status in words, for one that did not finish.
const STATUS_WORDS = { completed: t('completed'), failed: t('failed'), cancelled: t('cancelled'), interrupted: t('interrupted'), running: t('running'), cancelling: t('cancelling') };
const statusWord = status => STATUS_WORDS[status] || status;
function historyTitle(row) {
  const what = historyFindings(row).map(([, text]) => text).join(', ') || (row.result === 'clean' ? t('No findings') : statusWord(row.status));
  const where = row.gerrit ? `#${row.gerrit.change} · PS ${row.gerrit.ps}${row.gerrit.branch ? ` · ${row.gerrit.branch}` : ''}${historyOutdated(row) ? ` · ${t('Gerrit has PS {ps}', { ps: row.gerrit.current })}` : ''}` :
    t('Commit {sha}', { sha: row.local?.sha?.slice(0, 7) || '' });
  const run = [agentName(row.agent), row.model, row.effort].filter(Boolean).join(' · ') + (known(row.duration) ? ` · ${duration(row.duration)}` : '') +
    (known(row.cost) ? ` · $${row.cost.toFixed(2)}` : '');
  return [where, row.subject, run, what + (row.gerrit ? ` · ${row.gerrit.published ? t('published') : t('not published')}` : '') + (row.isNew ? ` · ${t('new')}` : '')].filter(Boolean).join('\n');
}

// The parts of a row.
function historyDot(row) {
  const outcome = historyOutcome(row), dot = element('span', undefined, `h-dot h-${outcome}`);
  // The most severe finding colors it; the counts are in the tooltip.
  if (outcome === 'findings') dot.classList.add(`kind-${FINDING_KINDS.map(([key]) => key).find(key => row.kinds?.[key]) || 'other'}`);
  return dot;
}
function historySubject(row) {
  const node = element('span', undefined, 'h-subject'), match = /^([A-Z][A-Z0-9]*-\d+)\s+(.*)$/.exec(row.subject || '');
  if (match) node.append(element('span', match[1], 'h-ticket'), document.createTextNode(` ${match[2]}`));
  else node.textContent = row.subject || t('Commit {sha}', { sha: row.local?.sha?.slice(0, 7) || '' });
  return node;
}
function historyPatchset(row) {
  const { ps, current } = row.gerrit, stale = current > ps;
  return element('span', stale ? `PS ${ps} → ${current}` : `PS ${ps}`, `h-ps${stale ? ' stale' : ''}`);
}
// Gerrit: whether this review is published. Local: only for a commit Gerrit
// has as is, whether an AI review of that patchset is published.
function historyCloud(row) {
  const published = row.gerrit ? row.gerrit.published : row.local?.published;
  if (published === undefined) return element('span');
  const node = element('span', undefined, `h-cloud${published ? ' published' : ''}`);
  node.append(qicon(published ? 'cloudCheck' : 'cloudUp'));
  return node;
}
function historyLink(row, withSha) {
  const node = element('span', undefined, `h-link ${HISTORY_LINK[row.local?.link?.state] || 'link-none'}`);
  node.append(qicon('link'));
  if (withSha) node.append(element('span', row.local.sha.slice(0, 7), 'h-sha'));
  return node;
}
function historyTime(row, withTime) {
  const node = element('span', historyWhen(row.startedAt, withTime), 'h-time');
  // Unread: after the date, where it shows best.
  if (row.isNew) node.append(element('i', undefined, 'h-new'));
  return node;
}
function historyReviewRow(row, { kid = false, chosen = false } = {}) {
  const gerrit = !!row.gerrit;
  const node = element('div', undefined, `h-row ${gerrit ? 'h-gerrit' : 'h-local'}${kid ? ' h-kid' : ''}${row.isNew ? ' is-new' : ''}`);
  node.dataset.tip = `r${row.id}`;
  if (!chosen) {
    node.dataset.id = row.id;
    node.setAttribute('role', 'option');
    node.setAttribute('aria-selected', String(row.id === chosenHistoryId()));
    node.setAttribute('aria-label', historyTitle(row).replace(/\n/g, ' · '));
    if (row.id === chosenHistoryId()) node.classList.add('chosen');
  }
  if (kid) {
    const model = element('span', undefined, 'h-model');
    model.append(document.createTextNode(row.model || agentName(row.agent)));
    if (row.effort) model.append(element('small', ` ${row.effort}`));
    node.append(historyDot(row), gerrit ? historyPatchset(row) : historyLink(row, true), model, historyCloud(row), historyTime(row, true));
  } else {
    node.append(historyDot(row), ...(gerrit ? [element('span', `#${row.gerrit.change}`, 'h-number'), historyPatchset(row)] : [historyLink(row, false)]),
      historySubject(row), historyCloud(row), historyTime(row, false));
  }
  return node;
}
// A group's own row: no result and no patchset or link, since its reviews may differ.
function historyGroupRow(group, open) {
  const head = group.rows[0], gerrit = !!head.gerrit;
  const node = element('div', undefined, `h-row h-group ${gerrit ? 'h-gerrit' : 'h-local'}${head.isNew ? ' is-new' : ''}`);
  node.dataset.group = group.key;
  node.dataset.tip = `g${group.key}`;
  node.setAttribute('role', 'option');
  node.setAttribute('aria-expanded', String(open));
  node.setAttribute('aria-label', tn(group.rows.length, '{subject}, {n} review', '{subject}, {n} reviews', { subject: `${gerrit ? `#${head.gerrit.change} ` : ''}${head.subject}` }));
  const chevron = element('span', undefined, 'h-chevron');
  chevron.append(qicon('chev'));
  node.append(chevron, ...(gerrit ? [element('span', `#${head.gerrit.change}`, 'h-number')] : []), historySubject(head), historyCloud(head),
    element('span', `×${group.rows.length}`, 'h-count'), historyTime(head, false));
  return node;
}

function historyChip(label, count, on, data) {
  const button = element('button', undefined, `h-chip${on ? ' on' : ''}${count === 0 ? ' zero' : ''}`);
  button.type = 'button';
  button.setAttribute('aria-pressed', String(on));
  Object.assign(button.dataset, data);
  button.append(document.createTextNode(label));
  if (count !== undefined) button.append(element('span', String(count), 'h-chip-count'));
  return button;
}
function renderHistoryPicker() {
  const tab = historyTabKey(), prefs = historyPrefs(tab), rows = historyRows(), chosenId = chosenHistoryId();
  const chosenRow = rows.find(row => row.id === chosenId);
  const chosenSignature = JSON.stringify(chosenRow || null);
  if (chosenSignature !== displayedHistoryChosen) {
    $('historyChosen').replaceChildren(chosenRow ? historyReviewRow(chosenRow, { chosen: true }) : element('span', t('Select a review…'), 'h-placeholder'));
    displayedHistoryChosen = chosenSignature;
  }
  $('historyTrigger').setAttribute('aria-expanded', String(historyOpen));
  $('historyPopup').hidden = !historyOpen;
  if (!historyOpen) { displayedHistoryList = undefined; return; }
  placeHistoryPopup();
  const signature = JSON.stringify([tab, rows, prefs, historyQuery, chosenId, ui.history.expanded]);
  if (signature === displayedHistoryList) return;
  displayedHistoryList = signature;

  const publish = historyToPublish(rows);
  const tests = { all: () => true, new: row => row.isNew, publish: row => publish.has(row.id) };
  if (!tests[prefs.filter] || (prefs.filter === 'publish' && tab !== 'gerrit')) prefs.filter = 'all';
  const branches = tab === 'gerrit' ? [...new Set(rows.map(row => row.gerrit?.branch).filter(Boolean))].sort() : [];
  if (prefs.branch && !branches.includes(prefs.branch)) prefs.branch = '';
  const searched = rows.filter(row => historyMatches(row, historyQuery));
  // Gerrit: the chosen branch. Local: only commits of the current branch, unless switched off.
  const onCurrent = row => tab !== 'local' || prefs.currentBranch === false || row.local?.onBranch !== false;
  const onBranch = row => (!prefs.branch || row.gerrit?.branch === prefs.branch) && onCurrent(row);
  const fresh = row => !(prefs.hideOld && historyOutdated(row)) && !(tab === 'gerrit' && prefs.hidePublished && historyPublished(row));
  const shown = searched.filter(row => tests[prefs.filter](row) && fresh(row) && onBranch(row));

  // Quick filters, and a switch that hides outdated reviews; counts follow the other choices.
  const filters = [['all', t('All')], ['new', t('New')], ...(tab === 'gerrit' ? [['publish', t('To publish')]] : [])];
  const outdated = searched.filter(row => historyOutdated(row) && onBranch(row) && !(tab === 'gerrit' && prefs.hidePublished && historyPublished(row))).length;
  const hide = historyChip(t('Hide outdated'), outdated, prefs.hideOld, { hideOld: '1' });
  hide.classList.add('h-toggle');
  hide.prepend(qicon('eyeOff'));
  hide.title = tab === 'gerrit' ? t('Hide reviews of patchsets Gerrit has moved on from.') : t('Hide reviews of versions Gerrit no longer has. Commits not on Gerrit stay.');
  const toggles = [hide];
  if (tab === 'local') {
    // Named for what it does; the branch itself is in its tooltip.
    const named = !!state.branch && !/^(Detached HEAD|Branch unavailable)/.test(state.branch);
    const count = searched.filter(row => row.local?.onBranch !== false && tests[prefs.filter](row) && fresh(row)).length;
    const current = historyChip(t('Current branch'), count, prefs.currentBranch !== false, { currentBranch: '1' });
    current.classList.add('h-toggle');
    current.prepend(qicon('branch'));
    current.title = named ? t('Only reviews of commits on the current branch, {branch}, with their older versions.', { branch: state.branch }) :
      t('Only reviews of commits on the current branch, with their older versions.');
    toggles.unshift(current);
  }
  if (tab === 'gerrit') {
    const published = searched.filter(row => historyPublished(row) && onBranch(row) && !(prefs.hideOld && historyOutdated(row))).length;
    const hidePublished = historyChip(t('Hide published'), published, prefs.hidePublished, { hidePublished: '1' });
    hidePublished.classList.add('h-toggle');
    hidePublished.prepend(qicon('cloudCheck'));
    hidePublished.title = t('Hide reviews of patchsets that already have a published AI review, from this review or another.');
    toggles.push(hidePublished);
  }
  $('historyFilters').replaceChildren(...filters.map(([key, label]) =>
    historyChip(label, key === 'all' ? undefined : searched.filter(row => tests[key](row) && fresh(row) && onBranch(row)).length, prefs.filter === key, { filter: key })), ...toggles);
  // Gerrit: the branches the reviews are for, when there are several.
  $('historyBranches').hidden = branches.length < 2;
  if (branches.length >= 2) {
    const icon = element('span', undefined, 'h-branch-icon');
    icon.title = t('Branch');
    icon.append(qicon('branch'));
    $('historyBranches').replaceChildren(icon, ...branches.map(branch => historyChip(branch,
      searched.filter(row => row.gerrit?.branch === branch && tests[prefs.filter](row) && fresh(row)).length, prefs.branch === branch, { branch })));
  }

  const groups = [], byKey = new Map();
  for (const row of shown) {
    const key = historyGroupKey(row);
    if (!byKey.has(key)) { byKey.set(key, { key, rows: [] }); groups.push(byKey.get(key)); }
    byKey.get(key).rows.push(row);
  }
  const list = $('historyList');
  list.replaceChildren();
  for (const group of groups) {
    if (group.rows.length === 1) { list.append(historyReviewRow(group.rows[0])); continue; }
    const open = ui.history.expanded?.[group.key] ?? group.rows.some(row => row.id === chosenId);
    const box = element('div', undefined, `h-groupbox${open ? ' open' : ''}`);
    box.append(historyGroupRow(group, open));
    if (open) {
      const kids = element('div', undefined, 'h-kids');
      kids.setAttribute('role', 'group');
      kids.append(...group.rows.map(row => historyReviewRow(row, { kid: true })));
      box.append(kids);
    }
    list.append(box);
  }
  if (!groups.length) {
    const elsewhere = tab === 'local' && prefs.currentBranch !== false ? searched.filter(row => row.local?.onBranch === false).length : 0;
    list.append(element('p', elsewhere ? t('No review of this branch. Turn off the branch filter to see {n} more.', { n: elsewhere }) : t('No review matches.'), 'h-empty'));
  }
  $('historyFoot').replaceChildren(element('span', `${tab === 'gerrit' ? tn(groups.length, '{n} change', '{n} changes') : tn(groups.length, '{n} commit', '{n} commits')} · ${tn(shown.length, '{n} review', '{n} reviews')}`),
    element('span', '↑↓ Enter · Esc'));
  // Group choices are kept only for groups that still exist.
  if (ui.history.expanded) {
    const keys = new Set(rows.map(historyGroupKey));
    for (const key of Object.keys(ui.history.expanded)) if (!keys.has(key)) delete ui.history.expanded[key];
  }
  saveUi();
  const items = historyItems();
  items.forEach((item, index) => { item.id = `historyItem${index}`; });
  setHistoryActive(items.find(item => historyItemKey(item) === historyActive), false);
}

// Below the chosen review, or above it when there is more room there.
function placeHistoryPopup() {
  if (!historyOpen) return;
  const popup = $('historyPopup'), box = $('historyTrigger').getBoundingClientRect();
  const below = innerHeight - box.bottom - 10, above = box.top - 10, down = below >= 260 || below >= above;
  popup.style.left = `${box.left}px`;
  popup.style.width = `${box.width}px`;
  popup.style.maxHeight = `${Math.min(460, Math.max(140, down ? below : above))}px`;
  popup.style.top = down ? `${box.bottom + 4}px` : '';
  popup.style.bottom = down ? '' : `${innerHeight - box.top + 4}px`;
}
addEventListener('resize', placeHistoryPopup);
document.addEventListener('scroll', event => { if (!$('historyPopup').contains(event.target)) placeHistoryPopup(); }, true);

// Keyboard and mouse.
const historyItems = () => [...$('historyList').querySelectorAll('.h-row')];
const historyItemKey = item => item?.dataset.id !== undefined ? `r${item.dataset.id}` : item?.dataset.group !== undefined ? `g${item.dataset.group}` : undefined;
function setHistoryActive(item, scroll = true) {
  for (const node of historyItems()) node.classList.toggle('active', node === item);
  historyActive = historyItemKey(item);
  if (item) { $('historySearch').setAttribute('aria-activedescendant', item.id); if (scroll) item.scrollIntoView({ block: 'nearest' }); }
  else $('historySearch').removeAttribute('aria-activedescendant');
}
function moveHistoryActive(step) {
  const items = historyItems();
  if (!items.length) return;
  const index = items.findIndex(item => item.classList.contains('active'));
  setHistoryActive(items[index < 0 ? (step > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, index + step))]);
}
function openHistory() {
  if (historyOpen) return;
  historyOpen = true;
  historyActive = chosenHistoryId() !== undefined ? `r${chosenHistoryId()}` : undefined;
  renderHistoryPicker();
  $('historySearch').focus();
  historyItems().find(item => item.classList.contains('active'))?.scrollIntoView({ block: 'nearest' });
}
function closeHistory(focusTrigger = false) {
  if (!historyOpen) return;
  historyOpen = false;
  hideHistoryCard();
  renderHistoryPicker();
  if (focusTrigger) $('historyTrigger').focus();
}
function toggleHistoryGroup(key, open) {
  ui.history.expanded = { ...(ui.history.expanded || {}), [key]: open };
  historyActive = `g${key}`;
  renderHistoryPicker();
}
function activateHistoryItem(item) {
  if (item.dataset.group !== undefined) { toggleHistoryGroup(item.dataset.group, item.getAttribute('aria-expanded') !== 'true'); return; }
  const id = item.dataset.id;
  closeHistory(true);
  send(historyTabKey() === 'gerrit' ? 'gerritHistory' : 'history', { id });
}
// The gear beside the agent and model on Review opens their settings.
on('agentSettings', 'click', () => send('openSettings', { tab: 'agent' }));
on('historyTrigger', 'click', () => historyOpen ? closeHistory(true) : openHistory());
on('historyTrigger', 'keydown', event => { if (event.key === 'ArrowDown' && !historyOpen) { event.preventDefault(); openHistory(); } });
on('historySearch', 'input', event => { historyQuery = event.target.value; historyActive = undefined; renderHistoryPicker(); });
on('historyPopup', 'keydown', event => {
  const active = historyItems().find(item => item.classList.contains('active'));
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveHistoryActive(event.key === 'ArrowDown' ? 1 : -1); }
  else if (event.key === 'Enter' && active) { event.preventDefault(); activateHistoryItem(active); }
  else if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && active?.dataset.group !== undefined && event.target === $('historySearch') && !$('historySearch').value) {
    event.preventDefault(); toggleHistoryGroup(active.dataset.group, event.key === 'ArrowRight');
  } else if (event.key === 'Escape') { event.preventDefault(); closeHistory(true); }
});
on('historyList', 'click', event => { const item = event.target.closest('.h-row'); if (item) activateHistoryItem(item); });
on('historyFilters', 'click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  const prefs = historyPrefs(historyTabKey());
  if (button.dataset.filter) prefs.filter = button.dataset.filter;
  if (button.dataset.hideOld) prefs.hideOld = !prefs.hideOld;
  if (button.dataset.hidePublished) prefs.hidePublished = !prefs.hidePublished;
  if (button.dataset.currentBranch) prefs.currentBranch = prefs.currentBranch === false;
  renderHistoryPicker();
});
on('historyBranches', 'click', event => {
  const button = event.target.closest('button[data-branch]');
  if (!button) return;
  const prefs = historyPrefs(historyTabKey());
  prefs.branch = prefs.branch === button.dataset.branch ? '' : button.dataset.branch;
  renderHistoryPicker();
});
document.addEventListener('mousedown', event => { if (historyOpen && !event.target.closest('#historyPicker')) closeHistory(); });

// A hover card instead of a plain tooltip. It waits where the pointer usually
// passes on its way to a click: on the chosen review and on a group's own row
// 1.7 s, on a review inside a group 1 s.
let historyCardTimer, historyHovered;
function historyCardContent(key) {
  const rows = historyRows(), parts = [];
  const title = row => {
    const node = element('div', undefined, 'tip-title'), match = /^([A-Z][A-Z0-9]*-\d+)\s+(.*)$/.exec(row.subject || '');
    if (match) node.append(chip(match[1], 'blue'), element('span', match[2], 'tip-subject'));
    else node.append(element('span', row.subject || t('Commit {sha}', { sha: row.local.sha.slice(0, 7) }), 'tip-subject'));
    return node;
  };
  // Short: as a line of a commit's versions, where Gerrit goes without saying.
  const linkText = (row, short) => {
    const link = row.local?.link || {}, target = link.change ? `#${link.change}${link.ps ? ` PS ${link.ps}` : ''}` : '';
    return link.state === 'current' ? (short ? t('this commit: {target}', { target }) : t('Gerrit has this commit: {target}', { target })) :
      link.state === 'outdated' ? (short ? t('another version: {target}', { target }) : t('Gerrit has another version: {target}', { target })) :
      ['checking', 'unknown'].includes(link.state) ? t('Checking Gerrit…') : t('Not on Gerrit');
  };
  const linkLine = (row, text) => {
    const node = element('div', undefined, `tip-line h-tip-link ${HISTORY_LINK[row.local?.link?.state] || 'link-none'}`);
    node.append(qicon('link'), element('span', row.local.sha.slice(0, 7), 'h-sha'), element('span', text));
    return node;
  };
  const publicationLine = row => {
    if (row.local?.published === undefined) return undefined;
    const link = row.local.link, node = element('div', undefined, `tip-line h-tip-cloud${row.local.published ? ' published' : ''}`);
    node.append(qicon(row.local.published ? 'cloudCheck' : 'cloudUp'), element('span', row.local.published ?
      t('AI review of #{change} PS {ps} is published', { change: link.change, ps: link.ps }) : t('AI review of #{change} PS {ps} is not published', { change: link.change, ps: link.ps })));
    return node;
  };
  const findings = row => {
    const node = element('div', undefined, 'tip-chips'), kinds = historyFindings(row);
    if (kinds.length) node.append(...kinds.map(([kind, text]) => chip(text, `find kind-${kind}`)));
    else node.append(HISTORY_OK.includes(row.result) ? chip(t('No findings'), 'ok', 'check') : chip(statusWord(row.status), 'bad'));
    return node;
  };
  const facts = row => {
    const node = element('div', undefined, 'tip-line tip-hint h-tip-facts');
    const fact = (icon, text) => { const part = element('span'); part.append(qicon(icon), document.createTextNode(text)); return part; };
    node.append(fact('cpu', [agentName(row.agent), row.model, row.effort].filter(Boolean).join(' · ')),
      ...(known(row.duration) ? [fact('clock', duration(row.duration))] : []), ...(known(row.cost) ? [fact('coin', `$${row.cost.toFixed(2)}`)] : []),
      fact('since', historyWhen(row.startedAt, true)));
    return node;
  };
  // Gerrit: the change, its patchset and branch, whether Gerrit moved on, publication.
  const change = (row, reviews) => {
    const node = element('div', undefined, 'tip-line h-tip-change');
    node.append(element('span', `#${row.gerrit.change}`, 'tip-number'), ...(reviews ? [] : [historyPatchset(row)]),
      ...(row.gerrit.branch ? [element('span', row.gerrit.branch, 'h-tip-branch')] : []), ...(reviews ? [element('span', `· ${tn(reviews, '{n} review', '{n} reviews')}`, 'h-tip-branch')] : []));
    return node;
  };
  const freshness = (row, reviewed) => {
    const current = row.gerrit.current;
    if (!current) return undefined;
    const node = element('div', undefined, `tip-line ${current > reviewed ? 'orange' : 'ok'}`);
    node.append(qicon(current > reviewed ? 'alert' : 'check'),
      element('span', current > reviewed ? t('Gerrit has PS {ps} now', { ps: current }) : t('PS {ps} is Gerrit’s current patchset', { ps: current })));
    return node;
  };
  const gerritPublication = row => {
    const node = element('div', undefined, `tip-line h-tip-cloud${row.gerrit.published ? ' published' : ''}`);
    node.append(qicon(row.gerrit.published ? 'cloudCheck' : 'cloudUp'), element('span', row.gerrit.published ? t('Published to Gerrit') :
      row.gerrit.publishedElsewhere ? t('Not published; another AI review of PS {ps} is', { ps: row.gerrit.ps }) : t('Not published to Gerrit')));
    return node;
  };
  if (key.startsWith('g') && rows.find(row => historyGroupKey(row) === key.slice(1))?.gerrit) {
    const group = rows.filter(row => historyGroupKey(row) === key.slice(1)), head = group[0];
    parts.push(title(head), change(head, group.length));
    const fresh = freshness(head, Math.max(...group.map(row => row.gerrit.ps)));
    if (fresh) parts.push(fresh);
    const list = element('div', undefined, 'h-tip-reviews');
    for (const row of group) {
      const line = element('div', undefined, 'h-tip-review'), model = element('span', undefined, 'h-model');
      model.append(document.createTextNode(row.model || agentName(row.agent)));
      if (row.effort) model.append(element('small', ` ${row.effort}`));
      line.append(historyDot(row), historyPatchset(row), model, historyCloud(row), element('span', historyWhen(row.startedAt, true), 'h-time'));
      list.append(line);
    }
    parts.push(list, element('div', t('Newest {date} · Click to show the reviews', { date: historyWhen(head.startedAt, true) }), 'tip-hint'));
    return parts;
  }
  if (key.startsWith('g')) {
    const group = rows.filter(row => historyGroupKey(row) === key.slice(1)), head = group[0];
    if (!head) return parts;
    const versions = [...new Map(group.map(row => [row.local.sha, row])).values()];
    parts.push(title(head));
    const facts = element('div', undefined, 'tip-line tip-hint');
    facts.append(qicon('hash'), element('span', `${head.local.changeId ? `${head.local.changeId.slice(0, 12)}… · ` : ''}${tn(versions.length, '{n} version', '{n} versions')} · ${tn(group.length, '{n} review', '{n} reviews')}`));
    parts.push(facts);
    const list = element('div', undefined, 'h-tip-versions');
    for (const version of versions) {
      const line = linkLine(version, linkText(version, true));
      line.append(element('span', `×${group.filter(row => row.local.sha === version.local.sha).length}`, 'h-count'));
      list.append(line);
    }
    parts.push(list);
    const published = publicationLine(versions.find(row => row.local.published !== undefined) || head);
    if (published) parts.push(published);
    parts.push(element('div', t('Newest {date} · Click to show the reviews', { date: historyWhen(head.startedAt, true) }), 'tip-hint'));
    return parts;
  }
  const row = rows.find(item => `r${item.id}` === key);
  if (!row) return parts;
  if (row.gerrit) {
    parts.push(title(row), change(row));
    const fresh = freshness(row, row.gerrit.ps);
    if (fresh) parts.push(fresh);
    parts.push(gerritPublication(row), findings(row), facts(row));
    return parts;
  }
  parts.push(title(row), linkLine(row, linkText(row)));
  const published = publicationLine(row);
  if (published) parts.push(published);
  parts.push(findings(row), facts(row));
  return parts;
}
function showHistoryCard(target) {
  const parts = historyCardContent(target.dataset.tip);
  if (!parts.length) return;
  const card = $('historyCard');
  card.replaceChildren(...parts);
  card.hidden = false;
  // Below the row, or above it when the window ends first.
  const box = target.getBoundingClientRect(), width = card.offsetWidth, height = card.offsetHeight;
  card.style.left = `${Math.max(6, Math.min(box.left, innerWidth - width - 6))}px`;
  card.style.top = `${box.bottom + 6 + height > innerHeight - 6 ? Math.max(6, box.top - height - 6) : box.bottom + 6}px`;
}
function hideHistoryCard() { clearTimeout(historyCardTimer); $('historyCard').hidden = true; }
document.addEventListener('mouseover', event => {
  const target = event.target.closest('#historyPicker [data-tip]');
  if (!target || target === historyHovered) return;
  historyHovered = target;
  hideHistoryCard();
  const delay = target.closest('#historyTrigger') || target.dataset.group !== undefined ? 1700 : target.classList.contains('h-kid') ? 1000 : 0;
  const show = () => { if (historyHovered === target && target.isConnected) showHistoryCard(target); };
  if (delay) historyCardTimer = setTimeout(show, delay); else show();
});
document.addEventListener('mouseout', event => {
  const target = event.target.closest('#historyPicker [data-tip]');
  if (target && !target.contains(event.relatedTarget)) { historyHovered = undefined; hideHistoryCard(); }
});
document.addEventListener('scroll', hideHistoryCard, true);

function renderHistory() {
  const gerrit = state.historyTab === 'gerrit';
  const entries = (gerrit ? state.gerritHistory : state.history) || [];
  const shown = gerrit ? state.gerritRun : state.run;
  for (const [tab, list] of [['local', state.history || []], ['gerrit', state.gerritHistory || []]]) {
    const selected = (tab === 'gerrit') === gerrit, fresh = list.filter(run => run.isNew).length;
    $(`${tab}Tab`).setAttribute('aria-selected', String(selected));
    $(`${tab}Tab`).tabIndex = selected ? 0 : -1;
    $(`${tab}TabCount`).textContent = String(list.length);
    $(`${tab}TabNew`).textContent = t('{n} NEW', { n: fresh });
    $(`${tab}TabNew`).hidden = !fresh;
    $(`${tab}Tab`).setAttribute('aria-label', `${tab === 'gerrit' ? t('Gerrit reviews: {n}', { n: list.length }) : t('Local reviews: {n}', { n: list.length })}${fresh ? `, ${t('{n} new', { n: fresh })}` : ''}`);
  }
  $('historyPanel').setAttribute('aria-labelledby', gerrit ? 'gerritTab' : 'localTab');
  $('historyPanel').dataset.tab = gerrit ? 'gerrit' : 'local';
  $('historyPicker').hidden = !entries.length;
  if (!entries.length) closeHistory();
  renderHistoryPicker();
  $('historyEmpty').hidden = !!entries.length;
  $('historyEmptyText').textContent = gerrit ? t('No Gerrit reviews yet') : t('No local reviews yet');
  $('historyDetails').hidden = !shown;
  $('localReportActions').hidden = gerrit || !shown;
  $('reports').hidden = !state.run?.hasReport || activeStatus(state.run.status);
  $('gerritReportActions').hidden = !gerrit || !shown;
  renderDiffButton(gerrit ? 'gerrit' : 'local', shown);
  $('gerritReports').disabled = !state.gerritRun?.hasReport || activeStatus(state.gerritRun?.status);
  if (gerrit) renderPublish();
  else { $('publicationStatus').hidden = true; $('sharedPublication').hidden = true; $('otherAiReviews').hidden = true; }
  fitTabs();
  const details = JSON.stringify([gerrit, shown?.id, shown?.status, shown?.error, shown?.summary, shown?.gerritPatch, shown?.gerritState,
    shown?.results?.[0]?.comments?.map(comment => [comment.file, comment.message?.slice(0, 20)]), shown?.signature, shown?.since]);
  if (details !== displayedDetails) { renderResults(shown); renderHistoryStats(shown); displayedDetails = details; }
}

window.addEventListener('message', event => {
  if (event.data.type !== 'state') return;
  state = event.data;
  $('notice').textContent = state.notice || '';
  renderSection(state.section);
  renderCommits();
  renderGerritPatches();
  renderPatches();
  renderConnections();
  renderDashboard();
  renderSettingsTabs();
  renderLanguage();
  renderUsageTotals();
  $('reviewStatus').setAttribute('class', `review-status status-${state.reviewStatus || 'idle'}`);
  $('reviewStatus').setAttribute('aria-label', state.reviewStatusLabel || t('Ready for review'));
  $('agent').value = state.agent || 'codex';
  const settingsSummary = [agentName(state.agent), state.model?.name || state.model?.id || t('Choose model'), state.effort || t('Default')].join(' · ');
  $('settingsSummary').textContent = settingsSummary;
  $('settingsSummary').title = settingsSummary;
  $('agent').disabled = !!state.busy || !!state.authBusy;
  $('model').textContent = state.model?.name || t('Choose model…');
  $('model').disabled = !!state.busy || !!state.loadingModels || !!state.authBusy;
  $('effort').replaceChildren(new Option(t('Default'), ''), ...(state.model?.efforts || []).map(e => new Option(e, e)));
  $('effort').value = state.effort || '';
  $('effort').disabled = !!state.busy || !state.model?.efforts?.length;
  $('mode').value = state.mode || 'full';
  $('mode').disabled = !!state.busy;
  if (document.activeElement !== $('commitLimit')) $('commitLimit').value = state.commitLimit ?? 30;
  const connection = state.connections?.find(entry => entry.agent === state.agent);
  const blocked = state.busy ? t('A review is already running or being prepared. Wait for it to finish or cancel it.') :
    state.authBusy ? t('Wait for agent sign-in or sign-out to finish.') :
    !state.repository ? t('Open a Git repository to review commits.') :
    !state.lreview || state.lreview.status === 'checking' ? t('Checking lreview installation…') :
    !state.lreview.installed ? t('Install lreview or configure Lustre Review: Lreview Path in VS Code settings.') :
    state.gerritPatches?.pending ? t('Wait for the Gerrit patch details to finish loading.') :
    !state.selected && !state.gerritPatches?.items?.length ? t('Select at least one local commit or add a Gerrit patch.') :
    connection?.status === 'checking' ? t('Checking the agent connection…') :
    connection?.status !== 'connected' ? t('Connect {agent} in AI Settings before reviewing.', { agent: agentName(state.agent) }) :
    state.loadingModels ? t('Wait for the model list to load.') :
    !state.model ? t('Choose a model in AI Settings before reviewing.') : '';
  $('review').disabled = !!blocked;
  $('reviewTip').textContent = blocked || t('Each selected local commit and Gerrit patchset is reviewed separately using the Lustre protocol. Uncommitted edits are excluded. Results are not published to Gerrit.');
  $('review').parentElement.tabIndex = blocked ? 0 : -1;
  $('autoOpenReports').checked = state.autoOpenReports !== false;
  $('cancelWrap').hidden = !state.activeId;
  $('logs').disabled = !state.reviewLogId;
  renderHistory();
  $('historyNewCount').hidden = !state.unreadCount;
  $('historyNewCount').textContent = t('{n} NEW', { n: state.unreadCount || 0 });
  $('clearNotifications').disabled = !state.unreadCount;
  $('clearHistory').disabled = !state.canClearHistory;
  const repositoryName = state.repository?.split('/').filter(Boolean).pop();
  $('clearHistoryDescription').textContent = repositoryName ? t('Hide finished reviews of {repository} from Reports & History. Report files are kept.', { repository: repositoryName }) :
    t('Open a Git repository to clear its review history.');
  renderStats();
});
setInterval(renderStats, 1000);
send('ready');
