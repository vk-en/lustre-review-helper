'use strict';

const crypto = require('node:crypto');
const { AGENTS } = require('./auth');
const { LANGUAGES, translator, localizeHtml } = require('./l10n');

// The line icons of the Review numbers, the same ones Reports & History uses.
const factIcon = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.map(d => `<path d="${d}"/>`).join('')}</svg>`;

// A small picture of each Gerrit patches view for the view menu, colored by
// the stylesheet: the colored edges and chips the real list uses.
function miniLayout(layout) {
  const box = (x, y, size) => `<rect class="mini-box" x="${x}" y="${y}" width="${size}" height="${size}" rx=".7"/>`;
  const bar = (kind, x, y, width, height = 2.4) => `<rect class="mini-${kind}" x="${x}" y="${y}" width="${width}" height="${height}" rx="${Math.min(1.2, height / 2)}"/>`;
  if (layout === 'cards') return [[1, 'blue'], [18, 'yellow']].map(([y, color]) =>
    `<rect class="mini-card" x="1" y="${y}" width="46" height="15" rx="2"/>${bar(color, 1, y, 1.8, 15)}${box(5, y + 2.2, 3.4)}${bar(color, 10.5, y + 2.7, 9)}` +
    `${bar('text', 5, y + 7.2, 34)}${bar('green', 5, y + 11, 7, 2.2)}${bar('green', 13.5, y + 11, 7, 2.2)}${bar('muted', 41, y + 2.2, 3.4, 3.4)}`).join('');
  if (layout === 'groups') {
    const header = (y, color) => `<circle class="mini-${color}" cx="2.5" cy="${y + 1.2}" r="1.5"/>${bar('muted', 6, y, 15)}`;
    const line = (y, color) => `${box(6, y, 3)}${bar('text', 11.5, y + 0.3, 26)}<circle class="mini-${color}" cx="43" cy="${y + 1.5}" r="1.3"/>`;
    return header(1, 'blue') + line(6, 'green') + line(10.5, 'red') + line(15, 'green') + header(20.5, 'yellow') + line(25.5, 'green') + line(30, 'green');
  }
  return [[1.5, 'blue'], [12.5, 'yellow'], [23.5, 'green']].map(([y, color]) =>
    `${bar(color, 1, y, 1.6, 9)}${box(4.5, y + 1, 3.6)}${bar('text', 10.5, y + 1.2, 28)}${bar(color, 10.5, y + 5.4, 8)}${bar('muted', 20.5, y + 5.4, 11)}${bar('muted', 42.5, y + 1, 3.6, 3.6)}`).join('');
}

const CLIENTS = { codex: 'Codex', claude: 'Claude Code', auggie: 'Auggie' };
// Small flags for the language list, drawn on a 30 by 20 grid.
const stripes = colors => colors.map((color, index) => `<rect y="${index * 20 / colors.length}" width="30" height="${20 / colors.length}" fill="${color}"/>`).join('');
const star = (x, y, r, turn = 0) => `<polygon fill="#ffde00" points="${[...Array(10)].map((_, i) => {
  const angle = -Math.PI / 2 + turn + i * Math.PI / 5, radius = i % 2 ? r * 0.382 : r;
  return `${(x + radius * Math.cos(angle)).toFixed(2)},${(y + radius * Math.sin(angle)).toFixed(2)}`;
}).join(' ')}"/>`;
const FLAGS = {
  en: '<rect width="30" height="20" fill="#012169"/><path d="M0 0l30 20M30 0 0 20" stroke="#fff" stroke-width="4"/><path d="M0 0l30 20M30 0 0 20" stroke="#c8102e" stroke-width="1.4"/><path d="M15 0v20M0 10h30" stroke="#fff" stroke-width="6"/><path d="M15 0v20M0 10h30" stroke="#c8102e" stroke-width="3.6"/>',
  de: stripes(['#000', '#dd0000', '#ffce00']),
  es: '<rect width="30" height="20" fill="#aa151b"/><rect y="5" width="30" height="10" fill="#f1bf00"/>',
  ja: '<rect width="30" height="20" fill="#fff"/><circle cx="15" cy="10" r="6" fill="#bc002d"/>',
  'zh-cn': `<rect width="30" height="20" fill="#ee1c25"/>${star(5, 5, 3)}${[[10, 2], [12, 4], [12, 7], [10, 9]].map(([x, y]) => star(x, y, 1, Math.atan2(5 - y, 5 - x) + Math.PI / 2)).join('')}`,
  ru: stripes(['#fff', '#0039a6', '#d52b1e']),
};
const flag = id => `<svg class="flag" viewBox="0 0 30 20" aria-hidden="true">${FLAGS[id]}</svg>`;
// Automatic: the language of VS Code, drawn as a screen with a globe.
const AUTO_ICON = factIcon(['M3 5h18v12H3z', 'M8 21h8', 'M12 17v4', 'M12 7.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z', 'M8.5 11h7', 'M12 7.5c1 1 1.4 2.2 1.4 3.5s-.4 2.5-1.4 3.5c-1-1-1.4-2.2-1.4-3.5s.4-2.5 1.4-3.5z']);

// l10n: the translator of the chosen language; the page is written in English
// and translated as a whole, its script gets the dictionary.
function reviewHtml(webview, vscode, extensionUri, l10n = translator('en', {}), language = {}) {
  return localizeHtml(pageHtml(webview, vscode, extensionUri, l10n, language), l10n.t);
}
// The page before its own English text is translated; what depends on the
// state is already in the language of l10n.
function pageHtml(webview, vscode, extensionUri, l10n, language) {
  const { t } = l10n;
  // Each language by its own name, and by its name in the language of the page.
  const names = { en: t('English'), de: t('German'), es: t('Spanish'), ja: t('Japanese'), 'zh-cn': t('Chinese (Simplified)'), ru: t('Russian') };
  const words = JSON.stringify({ language: l10n.language, locale: l10n.locale, words: l10n.words }).replace(/</g, '\\u003c');
  const nonce = crypto.randomBytes(18).toString('base64');
  const asset = name => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', name));
  return `<!doctype html><html lang="${l10n.language === 'zh-cn' ? 'zh-CN' : l10n.language}"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${asset('review.css')}"><title>Lustre Review Helper</title></head>
    <body><main>
      <section class="pane">
      <h2 class="pane-heading"><button id="settingsHeader" class="pane-toggle" aria-expanded="false" aria-controls="settingsPane" data-section="settings"><span class="settings-heading-text"><span>AI Settings</span><span id="settingsSummary" class="settings-summary"></span></span></button></h2>
      <div id="settingsPane" class="pane-body" role="region" aria-labelledby="settingsHeader" hidden>
      <div class="folder-tabs settings-tabs" role="tablist" aria-label="AI Settings categories"><button id="settingsTab-accounts" class="folder-tab settings-tab" role="tab" aria-selected="false" aria-controls="settingsPanel" data-tab="accounts" tabindex="-1" aria-label="Accounts" title="Accounts: sign Codex, Claude Code and Augment in or out." data-tip="Accounts: sign Codex, Claude Code and Augment in or out."><span class="tab-inner"><svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/><path d="M4 21a8 8 0 0 1 16 0"/></svg><span class="tab-full">Accounts</span><span class="tab-short" aria-hidden="true">Acc</span><span id="settingsAlert-accounts" class="tab-alert" hidden></span></span></button><button id="settingsTab-agent" class="folder-tab settings-tab" role="tab" aria-selected="false" aria-controls="settingsPanel" data-tab="agent" tabindex="-1" aria-label="Agent" title="Agent: the agent, model, reasoning and review depth for new reviews." data-tip="Agent: the agent, model, reasoning and review depth for new reviews."><span class="tab-inner"><svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 17l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/></svg><span class="tab-label">Agent</span><span id="settingsAlert-agent" class="tab-alert" hidden></span></span></button><button id="settingsTab-utilities" class="folder-tab settings-tab" role="tab" aria-selected="false" aria-controls="settingsPanel" data-tab="utilities" tabindex="-1" aria-label="Utilities" title="Utilities: git, lreview, gerrit-cli and gerrit-dashboard — installation, versions, bot name and the Gerrit connection." data-tip="Utilities: git, lreview, gerrit-cli and gerrit-dashboard — installation, versions, bot name and the Gerrit connection."><span class="tab-inner"><svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/></svg><span class="tab-full">Utilities</span><span class="tab-short" aria-hidden="true">Util</span><span id="settingsAlert-utilities" class="tab-alert" hidden></span></span></button><button id="settingsTab-mcp" class="folder-tab settings-tab" role="tab" aria-selected="false" aria-controls="settingsPanel" data-tab="mcp" tabindex="-1" aria-label="MCP" title="MCP: let your agents request reviews and fix their findings through Lustre Review Helper." data-tip="MCP: let your agents request reviews and fix their findings through Lustre Review Helper."><span class="tab-inner"><svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v5"/></svg><span class="tab-label">MCP</span><span id="settingsAlert-mcp" class="tab-alert" hidden></span></span></button><button id="settingsTab-other" class="folder-tab settings-tab" role="tab" aria-selected="false" aria-controls="settingsPanel" data-tab="other" tabindex="-1" aria-label="Other" title="Other: commits to display, all-time usage statistics and review history." data-tip="Other: commits to display, all-time usage statistics and review history."><span class="tab-inner"><svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h.01"/><path d="M12 12h.01"/><path d="M19 12h.01"/></svg><span class="tab-label">Other</span><span id="settingsAlert-other" class="tab-alert" hidden></span></span></button><button id="settingsTab-language" class="folder-tab settings-tab icon-only" role="tab" aria-selected="false" aria-controls="settingsPanel" data-tab="language" tabindex="-1" aria-label="Language" title="Language: the language of Lustre Review Helper." data-tip="Language: the language of Lustre Review Helper."><span class="tab-inner">${factIcon(['m5 8 6 6', 'm4 14 6-6 2-3', 'M2 5h12', 'M7 2h1', 'm22 22-5-10-5 10', 'M14 18h6']).replace('<svg ', '<svg class="tab-icon" ')}<span id="settingsAlert-language" class="tab-alert" hidden></span></span></button></div>
      <div id="settingsPanel" class="folder-panel settings-panel" role="tabpanel" aria-labelledby="settingsTab-accounts">
      <div class="settings-page" data-page="accounts">
      <div id="connections" class="connections" aria-label="Agent connections">
      ${['codex', 'claude', 'auggie'].map(agent => `<section class="connection-card" aria-label="${t('{agent} connection', { agent: CLIENTS[agent] })}">
        <div class="connection-heading"><strong>${CLIENTS[agent]} <span id="${agent}Version" class="cli-version"></span></strong><span class="button-tip help-tip"><button class="agent-help secondary" data-help="${agent}" aria-label="${t('{agent} official setup guide', { agent: CLIENTS[agent] })}" aria-describedby="${agent}Help">?</button><span id="${agent}Help" role="tooltip">${AGENTS[agent].url}</span></span></div>
        <div class="connection-actions"><span id="${agent}Connection" class="connection-status">Checking…</span><button id="${agent}Auth" class="secondary auth-button" data-agent="${agent}" disabled>Sign in</button></div>
        <p id="${agent}ConnectionHint" class="hint"></p>
      </section>`).join('')}
      </div>
      <div class="refresh-connections"><button id="refreshConnections" class="link">Refresh connections</button><span class="button-tip help-tip"><button class="agent-help secondary" aria-label="About refreshing connections" aria-describedby="refreshConnectionsHelp">?</button><span id="refreshConnectionsHelp" role="tooltip">Check installed CLI versions, agent sign-in status and lreview availability again. Also check Gerrit authentication and saved self-review MCP settings. Does not sign you in or out, update tools, publish comments, or start a review.</span></span></div>
      </div>
      <div class="settings-page" data-page="agent" hidden>
      <p id="agentEmpty" class="hint">Sign in to an agent under Accounts to choose its model.</p>
      <div id="modelSettings" hidden>
      <label for="agent">Agent</label><select id="agent"><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="auggie">Augment (Auggie)</option></select>
      <label for="model">Model</label><button id="model" class="secondary">Choose model…</button>
      <div class="row"><label class="field">Reasoning<select id="effort"><option value="">Default</option></select></label>
      <label class="field">Review depth<select id="mode"><option value="full">Full</option><option value="light">Light</option></select></label></div>
      </div>
      </div>
      <div class="settings-page" data-page="utilities" hidden>
      <section class="connection-card prerequisite" aria-label="Git installation">
        <div class="connection-heading"><strong>git</strong><span class="button-tip help-tip"><button id="gitHelp" class="agent-help secondary" aria-label="Git downloads" aria-describedby="gitHelpTip">?</button><span id="gitHelpTip" role="tooltip">https://git-scm.com/downloads</span></span></div>
        <p class="hint">Required to list commits, run reviews and open review diffs. Version 2.24 or newer.</p>
        <p id="gitInstallation" class="connection-status">Checking installation…</p>
        <p id="gitPath" class="hint"></p><button id="gitDownload" class="secondary" hidden>Download Git ↗</button>
      </section>
      <section class="connection-card prerequisite" aria-label="lreview installation">
        <div class="connection-heading"><strong>lreview</strong><span class="button-tip help-tip"><button id="lreviewHelp" class="agent-help secondary" aria-label="lreview on GitHub" aria-describedby="lreviewHelpTip">?</button><span id="lreviewHelpTip" role="tooltip">https://github.com/lustre-tools/llm_code_and_review_tools</span></span></div><p id="lreviewStatus" class="connection-status">Checking installation…</p>
        <p id="lreviewPath" class="hint"></p><button id="lreviewDownload" class="secondary" hidden>Download lreview ↗</button>
      </section>
      <section class="connection-card prerequisite" aria-label="Gerrit CLI installation and connection">
        <div class="connection-heading"><strong>gerrit-cli</strong><span class="button-tip help-tip"><button id="gerritHelp" class="agent-help secondary" aria-label="Gerrit CLI on GitHub" aria-describedby="gerritHelpTip">?</button><span id="gerritHelpTip" role="tooltip">https://github.com/lustre-tools/llm_code_and_review_tools/tree/main/gerrit_cli</span></span></div>
        <p class="hint">Required to read private changes and publish reviews on Gerrit.</p>
        <p id="gerritInstallation" class="connection-status">Checking installation…</p>
        <p id="gerritPath" class="hint"></p>
        <form id="gerritBotSettings">
          <div class="connection-heading"><label for="gerritBotName">Bot name</label><span class="button-tip help-tip"><button type="button" class="agent-help secondary" aria-label="About bot name" aria-describedby="gerritBotHelp">?</button><span id="gerritBotHelp" role="tooltip">Signs reports and published comments as [Bot name], or [AI review] if empty. Enable the checkbox to append the reviewed model and reasoning level (or Default). Changes apply to new reviews; saved reports keep their signature. This label does not change the Gerrit account.</span></span></div>
          <div class="row"><input id="gerritBotName" type="text" maxlength="80" placeholder="e.g. Lustre Bot" autocomplete="off"><button id="gerritBotSave" type="submit" class="secondary apply">Save</button></div>
          <label class="signature-details"><input id="gerritSignatureDetails" type="checkbox"><span>Include model and reasoning in signature</span></label>
          <p id="gerritBotSaved" class="hint" role="status"></p>
        </form>
        <div class="gerrit-config-row"><button id="gerritConfig" class="link">Open Gerrit CLI configuration</button><span class="button-tip help-tip"><button class="agent-help secondary" aria-label="About Gerrit configuration" aria-describedby="gerritConfigHelp">?</button><span id="gerritConfigHelp" role="tooltip">Opens the Gerrit CLI .env file for editing. Uses GERRIT_CLI_ENV_FILE, then the first existing file in ~/.config/gerrit-cli/.env, /etc/gerrit-cli/.env, /shared/support_files/.env or the selected repository's .env. If none exists, creates ~/.config/gerrit-cli/.env. Environment variables take precedence. Credentials stay in that file, not extension settings.</span></span></div>
        <p id="gerritConfigPath" class="hint"></p>
        <div class="connection-actions"><span id="gerritConnection" class="connection-status" role="status">Checking…</span><button id="gerritCheck" class="secondary auth-button">Check connection</button></div>
        <p id="gerritConnectionHint" class="hint"></p>
      </section>
      <section class="connection-card prerequisite" aria-label="gerrit-dashboard installation">
        <div class="connection-heading"><strong>gerrit-dashboard</strong><span class="button-tip help-tip"><button id="dashboardHelp" class="agent-help secondary" aria-label="gerrit-dashboard on GitHub" aria-describedby="dashboardHelpTip">?</button><span id="dashboardHelpTip" role="tooltip">https://github.com/lustre-tools/llm_code_and_review_tools/tree/main/gerrit_dashboard</span></span></div>
        <p class="hint">Lists the changes where you are a reviewer under Gerrit patches: Waiting Review and In progress. Reads Gerrit with the gerrit-cli account.</p>
        <p id="dashboardStatus" class="connection-status">Checking installation…</p>
        <p id="dashboardPath" class="hint"></p><button id="dashboardDownload" class="secondary" hidden>Download gerrit-dashboard ↗</button>
      </section>
      </div>
      <div class="settings-page" data-page="mcp" hidden>
      <footer class="self-review"><strong>Self-review via MCP</strong>
        <p class="hint">Let your agent request reviews through Lustre Review Helper and read what it knows about Gerrit.</p>
        ${['codex', 'claude', 'auggie'].map(agent => `<div class="mcp-connection"><div class="button-tip"><button id="${agent}Mcp" class="secondary" data-mcp="${agent}" aria-describedby="${agent}McpHelp" disabled>${t('Connect {agent}', { agent: agent === 'auggie' ? 'Auggie CLI' : CLIENTS[agent] })}</button><span id="${agent}McpHelp" role="tooltip">${agent === 'codex' ? 'Saves a user-wide Codex connection to this VS Code workspace. Connecting from another window replaces this endpoint.' : 'Saves a private MCP connection for the repository selected in Commits.'}</span></div><p id="${agent}McpStatus" class="hint" role="status"></p></div>`).join('')}
      </footer>
      </div>
      <div class="settings-page" data-page="other" hidden>
      <form id="commitSettings">
        <label for="commitLimit">Commits to display</label>
        <div class="row"><input id="commitLimit" type="number" min="1" max="200" step="1" value="30" required aria-describedby="commitLimitHint"><button type="submit" class="secondary apply">Apply</button></div>
        <p id="commitLimitHint" class="hint">Default: 30 · From 1 to 200. Updates the Commits list.</p>
      </form>
      <section class="statistics-settings" aria-label="Reset usage statistics">
        <hr class="settings-divider">
        <p id="resetStatisticsDescription" class="hint">Reset all-time token and cost totals across all projects. Review history and report files are kept.</p>
        <div class="button-tip"><button id="resetStatistics" class="link" aria-describedby="resetStatisticsDescription resetStatisticsHelp" disabled>Reset statistics</button><span id="resetStatisticsHelp" role="tooltip">Reset accumulated usage across all projects. History and report files are kept.</span></div>
      </section>
      <section class="statistics-settings" aria-label="Clear review history">
        <hr class="settings-divider">
        <p id="clearHistoryDescription" class="hint">Hide finished reviews of the current repository from Reports &amp; History. Report files are kept.</p>
        <div class="button-tip"><button id="clearHistory" class="link" aria-describedby="clearHistoryDescription clearHistoryHelp" disabled>Clear history</button><span id="clearHistoryHelp" role="tooltip">Hide finished reviews of this repository from Reports &amp; History and mark them read. Active reviews, report files and usage statistics are kept.</span></div>
      </section>
      </div>
      <div class="settings-page" data-page="language" hidden>
      <label id="languageLabel" for="languageTrigger">Language</label>
      <div id="languagePicker" class="language-picker">
        <button id="languageTrigger" class="language-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="languageList" aria-labelledby="languageLabel languageChosen"><span id="languageChosen" class="language-chosen"></span><svg class="history-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
        <div id="languageList" class="language-list" role="listbox" aria-labelledby="languageLabel" tabindex="-1" hidden>
          ${[{ id: 'auto' }, ...LANGUAGES].map(entry => `<div class="language-option" role="option" aria-selected="${entry.id === (language.setting || 'auto')}" data-language="${entry.id}" id="languageOption-${entry.id}">${entry.id === 'auto' ?
            `<span class="flag auto-flag">${AUTO_ICON}</span><span class="language-name">${t('Automatic')}</span><span class="language-note">${t('VS Code: {language}', { language: LANGUAGES.find(item => item.id === language.vscode)?.name || 'English' })}</span>` :
            `${flag(entry.id)}<span class="language-name" translate="no">${entry.name}</span>${names[entry.id].toLowerCase() === entry.name.toLowerCase() ? '' : `<span class="language-note">${names[entry.id]}</span>`}`}<svg class="language-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7"/></svg></div>`).join('')}
        </div>
      </div>
      <p class="hint">Automatic follows the display language of VS Code, and uses English when Lustre Review Helper does not have it. Settings and command names follow the display language of VS Code.</p>
      </div>
      </div>
      <section id="mcpExamples" class="mcp-examples" aria-labelledby="mcpExamplesTitle" hidden>
        <strong id="mcpExamplesTitle">Examples</strong>
        <p class="hint">After connecting, start a new chat in that agent and ask in plain words:</p>
        <ul class="hint">
          <li><q>Review the last commit with Lustre Review Helper.</q> Starts a review and waits for its result.</li>
          <li><q>We reviewed the patch on this branch: fix the findings and review it again.</q> Finds the earlier review, also of an amended commit, fixes the code and reviews only what changed.</li>
          <li><q>Show the findings of the review selected in VS Code.</q> Reads the review chosen in Reports &amp; History.</li>
          <li><q>Fix the review findings for EX-16094</q>, <q>for commit cdbe547</q> or <q>for change 66889</q>. Finds a review by subject, hash or Gerrit change.</li>
          <li><q>Are the findings of the selected review still current?</q> Compares the reviewed patchset with Gerrit: a newer patchset that changed the files with findings, CI, votes, and other AI reviews.</li>
          <li><q>Is my local patch up to date on Gerrit, or does it need a rebase?</q> Shows each commit's change: the same patchset, another version, merged, or a merge conflict.</li>
          <li><q>What is waiting for my review on Gerrit, and which of my reviews got a new patchset or an owner reply?</q> Reads the Waiting Review and In progress lists of Gerrit patches.</li>
        </ul>
        <p class="hint">Agents review and fix local commits only; nothing is published to Gerrit or voted on. Keep this VS Code window open.</p>
      </section>
      </div></section>
      <section class="pane">
      <h2 class="pane-heading"><button id="commitsHeader" class="pane-toggle" aria-expanded="true" aria-controls="commitsPane" data-section="commits">Local commits<span id="selectedCommitCount" class="selection-count">0</span></button></h2>
      <div id="commitsPane" class="pane-body" role="region" aria-labelledby="commitsHeader">
        <button id="repositoryPicker" class="link repository-picker" title="Choose repository"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span id="repositoryPath">Choose repository…</span></button>
        <div class="commit-toolbar"><div class="button-tip"><button id="refresh" class="secondary" aria-describedby="refreshTip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg><span>Refresh</span></button><span id="refreshTip" role="tooltip">Reload the commit list, the current branch and which commits already landed.</span></div><div class="button-tip"><button id="selectAll" class="secondary" aria-describedby="selectAllTip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="m8 12 3 3 5-6"/></svg><span>Select all</span></button><span id="selectAllTip" role="tooltip">Select every commit shown for review.</span></div><div class="button-tip"><button id="clearSelection" class="secondary" aria-describedby="clearSelectionTip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="m9 9 6 6"/><path d="m15 9-6 6"/></svg><span>Clear</span></button><span id="clearSelectionTip" role="tooltip">Clear the commit selection.</span></div><div class="button-tip"><button id="toggleMerged" class="secondary" aria-describedby="toggleMergedTip"><svg class="merged-show" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/></svg><svg class="merged-hide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.2"/><path d="M6.6 6.6C3.8 8.3 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m3 3 18 18"/></svg><span id="toggleMergedLabel">Show merged</span></button><span id="toggleMergedTip" role="tooltip">Show commits that already landed.</span></div></div>
        <p id="commitsLocked" class="hint" hidden>Wait for the current review to finish before changing the selection.</p>
        <div class="commit-context"><p id="commitCount" class="hint"></p><span id="currentBranch" class="hint" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 3v12"/><path d="M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M18 9a9 9 0 0 1-9 9"/></svg><span id="currentBranchText"></span></span></div>
        <ul id="commits" class="commit-list" aria-label="Recent commits"></ul>
      </div></section>
      <section class="pane">
      <h2 class="pane-heading"><button id="gerritPatchesHeader" class="pane-toggle" aria-expanded="false" aria-controls="gerritPatchesPane" data-section="gerritPatches">Gerrit patches<span id="gerritPatchCount" class="selection-count">0</span></button></h2>
      <div id="gerritPatchesPane" class="pane-body" role="region" aria-labelledby="gerritPatchesHeader" hidden>
        <div class="folder-tabs patches-tabs" role="tablist" aria-label="Gerrit patches">
          ${[['url', 'Gerrit URL', 'URL', 'Add a change by its Gerrit URL.', ['M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1', 'M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1']],
            ['waiting', 'Waiting Review', 'Waiting', 'Changes where you are a reviewer and have not reviewed or voted yet.', ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z']],
            ['progress', 'In progress', 'In prog.', 'Changes you already reviewed or commented on.', ['M12 3a9 9 0 1 0 9 9', 'M12 7v5l3 2']]]
            .map(([tab, full, short, tip, paths]) => `<button id="patchesTab-${tab}" class="folder-tab patches-tab" role="tab" aria-selected="false" aria-controls="patchesPanel" data-tab="${tab}" tabindex="-1" title="${tip}" data-tip="${tip}"><span class="tab-inner"><svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.map(d => `<path d="${d}"/>`).join('')}</svg><span class="tab-full">${full}</span><span class="tab-short" aria-hidden="true">${short}</span>${tab === 'url' ? '' : `<span id="${tab}TabCount" class="tab-count${tab === 'progress' ? ' fresh-count' : ''}" hidden></span>`}</span></button>`).join('')}
        </div>
        <div id="patchesPanel" class="folder-panel patches-panel" role="tabpanel" aria-labelledby="patchesTab-url">
        <section class="gerrit-patches-card patches-page" data-page="url" aria-label="Add Gerrit patches">
          <form id="addGerritPatch" novalidate>
            <label for="gerritPatchUrl">Gerrit URL</label>
            <input id="gerritPatchUrl" type="url" placeholder="https://review.whamcloud.com/64086" autocomplete="off" spellcheck="false" maxlength="4096" aria-describedby="gerritPatchHint gerritPatchMessage">
            <p id="gerritPatchHint" class="hint">Add a patch from review.whamcloud.com. Its Gerrit project must match the repository selected in Local commits.</p>
            <button id="gerritPatchAdd" type="submit" disabled>Add commit</button>
          </form>
          <p id="gerritPatchMessage" class="hint" role="status" aria-live="polite"></p>
          <p id="gerritPatchesEmpty" class="hint">No Gerrit patches added yet.</p>
          <ul id="gerritPatchList" class="gerrit-patch-list" aria-label="Added Gerrit patches"></ul>
        </section>
        <section id="queuePage" class="patches-page queue-page" data-page="queue" aria-label="Changes where you are a reviewer" hidden>
          <div class="queue-toolbar">
            <button id="queueRefresh" class="queue-tool" type="button" aria-label="Refresh Waiting Review and In progress" title="Refresh Waiting Review and In progress from Gerrit."><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></button>
            <span id="queueUpdated" class="queue-updated"></span>
            <div class="queue-view">
              <button id="queueView" class="queue-tool" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="queueViewMenu" aria-label="Choose how the list looks" title="Choose how the list looks."><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/></svg></button>
              <div id="queueViewMenu" class="queue-filter-menu queue-view-menu" role="menu" aria-labelledby="queueViewTitle" hidden>
                <strong id="queueViewTitle" class="queue-filter-title">View</strong>
                ${[['list', 'List', 'Two lines per change'], ['cards', 'Cards', 'All details at a glance'], ['groups', 'Groups', 'One line, grouped by state']]
                  .map(([value, label, hint]) => `<button type="button" role="menuitemradio" aria-checked="false" data-layout="${value}" tabindex="-1"><span class="diff-check" aria-hidden="true">✓</span><span class="view-option"><span>${label}</span><small>${hint}</small></span><span class="view-mini" aria-hidden="true"><svg viewBox="0 0 48 34">${miniLayout(value)}</svg></span></button>`).join('')}
              </div>
            </div>
            <div class="queue-filter">
              <button id="queueFilter" class="queue-tool" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="queueFilterMenu" aria-label="Filter the list" title="Choose which changes the list shows."><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18l-7 8.5V19l-4 2v-7.5z"/></svg><span id="queueFilterCount" class="queue-filter-count" hidden></span></button>
              <div id="queueFilterMenu" class="queue-filter-menu" role="dialog" aria-labelledby="queueFilterTitle" hidden>
                <strong id="queueFilterTitle" class="queue-filter-title">Show in list</strong>
                <div id="queueFilterOptions"></div>
                <div class="queue-filter-footer"><span id="queueFilterHidden"></span><button id="queueFilterReset" class="link" type="button">Reset</button></div>
              </div>
            </div>
          </div>
          <p id="queueMessage" class="hint" role="status"></p>
          <div id="queueList" class="queue-list"></div>
          <p id="queueHiddenNote" class="hint queue-hidden-note" hidden><span id="queueHiddenText"></span> · <button id="queueShowAll" class="link" type="button">Show all</button></p>
        </section>
        </div>
      </div></section>
      <section class="pane">
      <h2 class="pane-heading"><button id="reviewHeader" class="pane-toggle" aria-expanded="false" aria-controls="reviewPane" data-section="review">Review<svg id="reviewStatus" class="review-status status-idle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Ready for review"><path class="status-document" d="M13 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8M8 7h5M8 11h3M8 15h2"/><circle class="status-glass" cx="16.5" cy="12.5" r="4.5"/><path class="status-glass" d="m20 16 3 3"/><path class="status-check" d="m14.5 12.5 1.3 1.3 2.5-2.6"/></svg></button></h2>
      <div id="reviewPane" class="pane-body" role="region" aria-labelledby="reviewHeader" hidden>
      <div id="reviewContent" class="review-content">
      <div id="selectionBlock">
      <p id="selection" class="muted"></p>
      <ul id="selectedCommits" class="selected-commits" aria-label="Selected commits" hidden></ul>
      <p id="gerritSelection" class="muted"></p>
      <ul id="selectedGerritPatches" class="selected-commits" aria-label="Selected Gerrit patches" hidden></ul>
      </div>
      <section id="batchProgress" class="batch-progress" aria-labelledby="batchTitle" hidden>
        <p id="batchTitle" class="muted"></p>
        <ul id="batchItems" class="batch-items"></ul>
      </section>
      <section id="stats" class="stats-card" aria-label="Review statistics">
        <canvas id="scanner" role="img" aria-label="An eye scans files of machine code with a laser, from top to bottom" hidden></canvas>
        <div class="activity"><span class="ready-robot" aria-hidden="true"><span class="robot-face"><i></i><i></i><b></b></span></span><div class="activity-text"><span class="configuration-line"><span id="reviewConfiguration" class="review-configuration"></span><button id="agentSettings" class="configuration-settings" type="button" title="Agent settings" aria-label="Agent settings: agent, model and reasoning">${factIcon(['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'])}</button></span><span class="activity-line"><span id="activity" class="status-pill tone-idle">Ready for review</span><span id="lastActivity" class="activity-age"></span></span></div></div>
        <div id="metrics" class="rc-facts review-facts" hidden>
          <span id="elapsedFact" class="fact-time">${factIcon(['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'])}<span id="elapsed">00:00</span></span>
          <span id="tokensFact" class="fact-tokens">${factIcon(['m12 3 9 5-9 5-9-5z', 'm3 13 9 5 9-5'])}<span id="tokens">—</span></span>
          <span id="costFact" class="fact-cost">${factIcon(['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.4 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-2-.5-2.5-1.5', 'M12 6.5v1.5', 'M12 16v1.5'])}<span id="cost">—</span></span>
          <span id="progressFact" class="fact-done" title="Reviews done">${factIcon(['m2 12.5 4.5 4.5L16 7', 'm11 16 1 1 9.5-10'])}<span id="progress">0 / 0</span></span>
        </div>
        <section id="limits" class="limits" aria-label="Account usage limits" hidden></section>
      </section>
      <label class="auto-open-reports"><input id="autoOpenReports" type="checkbox" checked><span>Open reports in new tabs when finished</span></label>
      <div class="row review-actions">
        <div class="button-tip log-tip"><button id="logs" class="secondary log-button" aria-label="Open review log" aria-describedby="logTip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 8 4 4-4 4m7 0h5"/></svg></button><span id="logTip" role="tooltip">Open the review log in the Output panel.</span></div>
        <div class="button-tip review-tip"><button id="review" aria-describedby="reviewTip" disabled>Start review</button><span id="reviewTip" role="tooltip">Each selected local commit and Gerrit patchset is reviewed separately using the Lustre protocol. Uncommitted edits are excluded. Results are not published to Gerrit.</span></div>
        <div id="cancelWrap" class="button-tip cancel-tip" hidden><button id="cancel" class="secondary" aria-describedby="cancelTip">Cancel</button><span id="cancelTip" role="tooltip">🌍 Save nature</span></div>
      </div>
      </div>
      <footer class="usage-footer" aria-label="All-time usage across all projects">
        <div class="usage-header"><span id="usageTitle">All-time usage · all projects</span><button id="toggleUsage" type="button" aria-expanded="false" aria-controls="usageDetails" aria-label="Show all-time usage">Show</button></div>
        <div id="usageDetails" hidden>
          <table class="usage-table" aria-labelledby="usageTitle">
            <thead><tr><th scope="col">Agent</th><th scope="col">Model</th><th scope="col">Cost</th><th scope="col">Tokens</th></tr></thead>
            <tbody id="usageTotals"></tbody>
          </table>
          <p id="usageTotalsNote"></p>
        </div>
      </footer>
      </div></section>
      <section class="pane">
      <h2 class="pane-heading"><button id="historyHeader" class="pane-toggle" aria-expanded="false" aria-controls="historyPane" data-section="history">Reports &amp; History<span id="historyNewCount" class="new-badge" hidden></span></button></h2>
      <div id="historyPane" class="pane-body" role="region" aria-labelledby="historyHeader" hidden>
      <div class="history-toolbar"><div class="history-buttons"><button id="clearNotifications" class="secondary mini-button" disabled>Clear notifications</button></div></div>
      <div class="folder-tabs history-tabs" role="tablist" aria-label="Review history">
        ${['local', 'gerrit'].map(tab => `<button id="${tab}Tab" class="folder-tab history-tab" role="tab" aria-selected="false" aria-controls="historyPanel" data-tab="${tab}" tabindex="-1"><span class="tab-inner"><span class="tab-full">${tab === 'local' ? 'Local' : 'Gerrit'}</span><span class="tab-short" aria-hidden="true">${tab === 'local' ? 'L' : 'G'}</span><span id="${tab}TabCount" class="tab-count">0</span><span id="${tab}TabNew" class="new-badge" hidden></span></span></button>`).join('')}
      </div>
      <div id="historyPanel" class="folder-panel history-panel" role="tabpanel" aria-labelledby="localTab">
      <div id="historyPicker" class="history-picker" hidden>
        <button id="historyTrigger" class="history-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="historyPopup"><span id="historyChosen" class="history-chosen"></span><svg class="history-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
        <div id="historyPopup" class="history-popup" hidden>
          <label class="history-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg><input id="historySearch" type="text" placeholder="Number, ticket, subject or model" aria-label="Filter reviews" autocomplete="off" spellcheck="false"></label>
          <div id="historyFilters" class="history-filters" role="group" aria-label="Show"></div>
          <div id="historyBranches" class="history-filters history-branches" role="group" aria-label="Branch" hidden></div>
          <div id="historyList" class="history-list" role="listbox" aria-label="Reviews"></div>
          <div id="historyFoot" class="history-foot"></div>
        </div>
      </div>
      <div id="historyEmpty" class="history-empty" hidden><span class="ready-robot" aria-hidden="true"><span class="robot-face"><i></i><i></i><b></b></span></span><span id="historyEmptyText">No local reviews yet</span></div>
      <section id="historyDetails" class="history-details" aria-labelledby="historyDetailsLabel" hidden>
      <strong id="historyDetailsLabel" class="details-heading">General information</strong>
      <section id="results" aria-live="polite"></section>
      <section id="historyStats" class="stats-card history-stats" aria-label="Saved review statistics" hidden></section>
      <div id="localReportActions" class="report-actions" hidden><div class="report-group"><div class="diff-split"><div class="button-tip diff-tip"><button id="localDiff" class="secondary log-button" aria-label="Open the diff with review comments" aria-describedby="localDiffTip" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 11v6M9 14h6"/></svg></button><span id="localDiffTip" role="tooltip">Open the diff with review comments.</span></div><button id="localDiffMenu" class="secondary diff-toggle" aria-label="Choose which files the diff shows" aria-haspopup="menu" aria-expanded="false" aria-controls="localDiffOptions" disabled><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button><div id="localDiffOptions" class="diff-menu" role="menu" aria-label="Diff scope" hidden><button role="menuitemradio" aria-checked="true" data-scope="commented" data-tab="local"><span class="diff-check" aria-hidden="true">✓</span><span>Files with comments</span><span id="localDiffCount" class="diff-count"></span></button><button role="menuitemradio" aria-checked="false" data-scope="all" data-tab="local"><span class="diff-check" aria-hidden="true">✓</span><span>All changed files</span></button></div></div><button id="reports" class="report-button" hidden>Open report results</button></div></div>
      <div id="gerritReportActions" class="report-actions" hidden><div class="report-group"><div class="diff-split"><div class="button-tip diff-tip"><button id="gerritDiff" class="secondary log-button" aria-label="Open the diff with review comments" aria-describedby="gerritDiffTip" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 11v6M9 14h6"/></svg></button><span id="gerritDiffTip" role="tooltip">Open the diff with review comments.</span></div><button id="gerritDiffMenu" class="secondary diff-toggle" aria-label="Choose which files the diff shows" aria-haspopup="menu" aria-expanded="false" aria-controls="gerritDiffOptions" disabled><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button><div id="gerritDiffOptions" class="diff-menu" role="menu" aria-label="Diff scope" hidden><button role="menuitemradio" aria-checked="true" data-scope="commented" data-tab="gerrit"><span class="diff-check" aria-hidden="true">✓</span><span>Files with comments</span><span id="gerritDiffCount" class="diff-count"></span></button><button role="menuitemradio" aria-checked="false" data-scope="all" data-tab="gerrit"><span class="diff-check" aria-hidden="true">✓</span><span>All changed files</span></button></div></div><button id="gerritReports" class="report-button" disabled>Read report</button></div><div id="publishGroup" class="publish-group"><button id="publishLock" class="publish-lock" type="button" aria-pressed="false" aria-label="Unlock Publish to Gerrit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path class="lock-closed" d="M8 11V8a4 4 0 0 1 8 0v3"/><path class="lock-open" d="M8 11V8a4 4 0 0 1 7.7-1.5"/></svg></button><button id="publishGerrit" disabled>Publish to Gerrit</button></div></div>
      <div id="otherAiReviews" class="other-ai" role="status" hidden></div>
      <p id="publicationStatus" class="hint" role="status" aria-live="polite" hidden></p>
      <p id="sharedPublication" class="hint shared-publication" role="status" hidden></p>
      </section>
      </div>
      </div></section>
      <p id="notice" role="status" aria-live="polite"></p>
      <div id="queueTip" class="queue-tip" hidden></div>
      <div id="historyCard" class="queue-tip history-card" hidden></div>
    </main><script type="application/json" id="l10nData">${words}</script>
    <script nonce="${nonce}" src="${asset('scanner.js')}"></script>
    <script nonce="${nonce}" src="${asset('review.js')}"></script></body></html>`;
}

module.exports = { reviewHtml, pageHtml };
