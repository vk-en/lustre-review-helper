'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { codexLimits } = require('./limits');
const { t } = require('./l10n');
const { version } = require('../package.json');

async function executable(name, explicit = '', candidates = []) {
  if (explicit && !path.isAbsolute(explicit)) throw new Error(t('{name} path must be absolute.', { name }));
  const paths = explicit ? [explicit] : [...candidates,
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(p => path.join(p, name)),
    path.join(os.homedir(), '.local', 'bin', name), path.join('/opt/homebrew/bin', name),
    path.join('/usr/local/bin', name)];
  for (const candidate of paths) {
    try { await fs.access(candidate, fs.constants.X_OK); return candidate; } catch { /* Try the next location. */ }
  }
  throw new Error(t('{name} was not found. Set lustreReview.{name}Path to its absolute executable path.', { name }));
}

function extensionCodexPaths(extensionPath) {
  if (!extensionPath) return [];
  const platform = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform];
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
  return [path.join(extensionPath, 'bin', `${platform}-${arch}`, process.platform === 'win32' ? 'codex.exe' : 'codex')];
}

async function createAgentLauncher(binary, directory, agent = 'codex') {
  if (!['codex', 'claude', 'auggie'].includes(agent)) throw new Error('Unsupported review agent.');
  // Codex discovers sibling executables (e.g. codex-code-mode-host) using
  // its executable location. A symlink in the run directory breaks that
  // lookup. exec the real installation path, preserving argv and signals.
  const target = await fs.realpath(binary);
  const quoted = "'" + target.replaceAll("'", "'\\''") + "'";
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const launcher = path.join(directory, agent);
  await fs.writeFile(launcher, `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o700, flag: 'wx' });
  return launcher;
}

// A short-lived, read-only app-server connection. No inference turn is started.
async function withAppServer(binary, work, { timeout = 20000, spawnProcess = spawn, signal } = {}) {
  const child = spawnProcess(binary, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let serial = 0;
  let stderr = '';
  const pending = new Map();
  const fail = error => { for (const p of pending.values()) p.reject(error); pending.clear(); };
  child.on('error', fail);
  child.on('exit', () => fail(new Error(`Codex query stopped. ${stderr.slice(-1000)}`)));
  child.stdin.on('error', fail);
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || 'Codex request failed.'));
    else waiter.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const timer = setTimeout(() => {
    fail(new Error(t('Codex query timed out. Check the Codex login and connection.')));
    child.kill();
  }, timeout);
  const abort = () => { fail(new Error('Codex query cancelled.')); child.kill(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('Codex query cancelled.');
    await request('initialize', { clientInfo: { name: 'lustre_review_vscode', title: 'Lustre Review Helper', version } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    return await work(request);
  } finally {
    signal?.removeEventListener('abort', abort);
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

async function listModels(binary, options) {
  return withAppServer(binary, async request => {
    const models = [];
    let cursor;
    const seen = new Set();
    do {
      const page = await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page?.data)) throw new Error(t('Codex returned an invalid model catalog.'));
      for (const model of page.data) {
        if (model.hidden || !model.model || models.some(m => m.id === model.model)) continue;
        models.push({ id: model.model, name: model.displayName || model.model,
          description: model.description || '', isDefault: !!model.isDefault,
          defaultEffort: model.defaultReasoningEffort,
          efforts: (model.supportedReasoningEfforts || []).map(e => e.reasoningEffort) });
      }
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('Codex returned a repeated model cursor.');
      seen.add(cursor);
    } while (cursor);
    if (!models.length) throw new Error(t('Codex returned no visible models. Check its login and provider configuration.'));
    return models;
  }, options);
}

async function readLimits(binary, options) {
  return withAppServer(binary, async request => codexLimits(await request('account/rateLimits/read', {})), options);
}

module.exports = { executable, extensionCodexPaths, createAgentLauncher, createCodexLauncher: createAgentLauncher, listModels, readLimits };
