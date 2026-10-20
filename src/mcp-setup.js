'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { AGENTS } = require('./auth');
const { t } = require('./l10n');

const SERVER = 'lreview_vscode';

// Augment starts an MCP server through a shell that splits its path at spaces,
// and VS Code's helper and storage paths have them. Augment gets a small
// launcher in its own settings folder instead, which starts the same server.
const launcherFolder = home => path.join(home, '.augment', 'lustre-review');
const launcherPath = (connectionFile, home) =>
  path.join(launcherFolder(home), `mcp-${crypto.createHash('sha256').update(connectionFile).digest('hex').slice(0, 12)}.sh`);
const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
const PLAIN_PATH = /^[\w./-]+$/;
function launcherScript(runtime, connectionFile, command) {
  return '#!/bin/sh\n# Lustre Review starts its MCP server for Augment from here: Augment cannot\n' +
    '# start a program whose path has spaces. Reconnect in AI Settings > MCP to update it.\n' +
    `ELECTRON_RUN_AS_NODE=1 exec ${quote(command)} ${quote(path.join(runtime, 'mcp.js'))} --connection ${quote(connectionFile)}\n`;
}
const augmentLauncher = (connectionFile, home) => process.platform !== 'win32' && PLAIN_PATH.test(launcherPath(connectionFile, home));

function serverConfig(runtime, connectionFile, command = process.execPath, { agent, home = os.homedir() } = {}) {
  const env = { ELECTRON_RUN_AS_NODE: '1' };
  if (agent === 'auggie') {
    if (augmentLauncher(connectionFile, home)) return { type: 'stdio', command: launcherPath(connectionFile, home), args: [], env };
    // A home folder whose path has spaces: quote for Augment's shell instead.
    return { type: 'stdio', command: quote(command), args: [quote(path.join(runtime, 'mcp.js')), '--connection', quote(connectionFile)], env };
  }
  return { type: 'stdio', command, args: [path.join(runtime, 'mcp.js'), '--connection', connectionFile], env };
}

async function writeLauncher(runtime, connectionFile, command, home) {
  const file = launcherPath(connectionFile, home), temporary = `${file}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporary, launcherScript(runtime, connectionFile, command), { mode: 0o700 });
    await fs.chmod(temporary, 0o700);
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

function execute(binary, args, { cwd, env }) {
  return new Promise(resolve => {
    // No shell, interactive prompts or inference; do not expose CLI output,
    // which may contain unrelated settings or credentials on failure.
    execFile(binary, args, { cwd, env: { ...env, AUGMENT_DISABLE_AUTO_UPDATE: '1', NO_COLOR: '1' },
      timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 },
    error => resolve({ code: error ? error.code : 0 }));
  });
}

async function claudeServer(repository, env) {
  const file = env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
  try {
    const config = JSON.parse(await fs.readFile(file, 'utf8'));
    return config.projects?.[repository]?.mcpServers?.[SERVER];
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(t('Cannot read Claude Code MCP configuration. No settings were changed.'));
  }
}

function readCommand(binary, args, { cwd, env, signal }) {
  return new Promise(resolve => {
    execFile(binary, args, { cwd, env: { ...env, NO_COLOR: '1', AUGMENT_DISABLE_AUTO_UPDATE: '1' },
      timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, signal },
    (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

async function checkMcp({ agent, binary, repository, runtime, connectionFile, command = process.execPath,
  env = process.env, signal, read = readCommand, home = os.homedir() }) {
  const result = (status, message) => ({ status, configured: status === 'configured', message });
  if (!Object.hasOwn(AGENTS, agent)) throw new Error('Unknown agent.');
  try {
    const cwd = await fs.realpath(repository);
    let server, enabled = true;
    if (agent === 'codex') {
      // get reads configuration only; unlike health/list commands in some
      // clients, it does not launch MCP servers or spend model tokens.
      const response = await read(binary, ['mcp', 'get', '--json', SERVER], { cwd, env, signal });
      if (response.code !== 0) {
        if (!/No MCP server named\b/.test(response.stderr || '')) throw new Error('Cannot read configuration');
      } else {
        const config = JSON.parse(response.stdout);
        if (config.name !== SERVER || !config.transport) throw new Error('Unexpected configuration');
        server = config.transport; enabled = config.enabled !== false;
      }
    } else if (agent === 'claude') server = await claudeServer(cwd, env);
    else {
      try {
        const config = JSON.parse(await fs.readFile(path.join(cwd, '.augment', 'settings.local.json'), 'utf8'));
        server = config.mcpServers?.[SERVER];
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!server) return result('missing', t('Not configured for this workspace.'));
    if (!enabled || server.disabled === true || server.enabled === false) return result('disabled', t('The saved MCP connection is disabled. Reconnect to enable it.'));
    const expected = serverConfig(runtime, connectionFile, command, { agent, home });
    let matches = server.command === expected.command && JSON.stringify(server.args) === JSON.stringify(expected.args) &&
      server.env?.ELECTRON_RUN_AS_NODE === '1' && (!server.type || server.type === 'stdio');
    // Augment's launcher must also still start this window's server.
    if (matches && agent === 'auggie' && !expected.args.length) {
      matches = await fs.readFile(expected.command, 'utf8').then(text => text === launcherScript(runtime, connectionFile, command), () => false);
    }
    if (matches) return result('configured', t('Configured for this VS Code window. Start a new agent chat and keep this window open.'));
    if (agent === 'auggie' && augmentLauncher(connectionFile, home)) {
      if (typeof server.command === 'string' && server.command.startsWith(launcherFolder(home) + path.sep) && server.command !== expected.command) {
        return result('otherWorkspace', t('Configured for another VS Code window. Connect this window to use self-review here.'));
      }
      if (Array.isArray(server.args) && server.args.includes('--connection')) {
        return result('outdated', t('Augment cannot start this saved connection: its paths have spaces. Reconnect this window.'));
      }
    }
    const connectionIndex = Array.isArray(server.args) ? server.args.indexOf('--connection') : -1;
    if (connectionIndex >= 0 && server.args[connectionIndex + 1] && server.args[connectionIndex + 1] !== connectionFile) {
      return result('otherWorkspace', t('Configured for another VS Code window. Connect this window to use self-review here.'));
    }
    return result('outdated', t('The saved MCP configuration needs updating. Reconnect this window.'));
  } catch {
    // Never return configuration contents, CLI diagnostics or credentials.
    return result('unknown', t('Could not check saved MCP settings. Refresh connections to retry.'));
  }
}

async function connectMcp({ agent, binary, repository, runtime, connectionFile, command = process.execPath,
  env = process.env, run = execute, home = os.homedir() }) {
  if (!Object.hasOwn(AGENTS, agent)) throw new Error('Unknown agent.');
  const cwd = await fs.realpath(repository);
  const server = serverConfig(runtime, connectionFile, command, { agent, home });
  const invoke = args => run(binary, args, { cwd, env });
  const failure = () => new Error(t('{agent} could not configure self-review. Check that the CLI is up to date and its settings are writable, then retry.', { agent: AGENTS[agent].name }));
  if (agent === 'codex') {
    // Native upsert edits this server only and preserves other TOML settings.
    const result = await invoke(['mcp', 'add', SERVER, '--env', 'ELECTRON_RUN_AS_NODE=1', '--', server.command, ...server.args]);
    if (result.code !== 0) throw failure();
  } else if (agent === 'auggie') {
    if (!server.args.length) {
      try { await writeLauncher(runtime, connectionFile, command, home); }
      catch { throw new Error(t('Could not write Augment’s self-review launcher in {folder}. Check that folder’s permissions, then retry.', { folder: launcherFolder(home) })); }
    }
    const result = await invoke(['mcp', 'add-json', '--local', '--replace', SERVER, JSON.stringify(server)]);
    if (result.code !== 0) throw failure();
  } else {
    // Claude's add-json refuses an existing local entry. Keep an exact copy
    // for rollback and let its CLI perform the locked config writes.
    const previous = await claudeServer(cwd, env);
    const matches = previous?.command === server.command && JSON.stringify(previous.args) === JSON.stringify(server.args) &&
      previous.env?.ELECTRON_RUN_AS_NODE === '1' && (!previous.type || previous.type === 'stdio');
    if (matches) return;
    const add = value => invoke(['mcp', 'add-json', '--scope', 'local', SERVER, JSON.stringify(value)]);
    if (previous) {
      const removed = await invoke(['mcp', 'remove', '--scope', 'local', SERVER]);
      if (removed.code !== 0) throw failure();
    }
    const result = await add(server);
    if (result.code !== 0) {
      if (previous && (await add(previous)).code !== 0) {
        throw new Error(t('Claude Code could not update or restore its self-review connection. Reconnect after checking the CLI and settings permissions. Other MCP entries were not removed.'));
      }
      throw failure();
    }
  }
}

module.exports = { connectMcp, checkMcp, serverConfig, launcherScript };
