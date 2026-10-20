'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { claudeLimits } = require('./limits');
const { t } = require('./l10n');

function extensionClaudePaths(extensionPath) {
  return extensionPath ? [path.join(extensionPath, 'resources', 'native-binary',
    process.platform === 'win32' ? 'claude.exe' : 'claude')] : [];
}

// Claude Code's SDK initialize response includes its model picker catalog.
// Send only a control request, never a user message or an inference prompt.
function readControl(binary, request, { timeout = 20000, spawnProcess = spawn, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(binary, ['-p', '--input-format', 'stream-json',
      '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--settings', '{"disableAllHooks":true}'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;
    const lines = readline.createInterface({ input: child.stdout });
    const abort = () => finish(new Error('Claude Code query cancelled.'));
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      lines.close();
      child.stdin.end();
      child.kill();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(t('Claude Code query timed out. Check its login and update Claude Code.'))), timeout);
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.on('exit', () => finish(new Error(`Claude Code query stopped. ${stderr.slice(-1000)}`)));
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type !== 'control_response' || !['catalog', 'usage'].includes(message.response?.request_id)) return;
      const response = message.response;
      if (response.subtype === 'error') return finish(new Error(String(response.error || 'Claude Code initialization failed.')));
      if (response.request_id === 'catalog' && request) {
        child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'usage', request }) + '\n');
        return;
      }
      finish(null, response.response);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'catalog', request: { subtype: 'initialize' } }) + '\n');
  });
}

async function listModels(binary, options) {
  const catalog = (await readControl(binary, null, options))?.models;
  if (!Array.isArray(catalog)) throw new Error(t('Claude Code returned no model catalog. Update the Claude Code extension or CLI.'));
  const models = [];
  for (const model of catalog) {
    if (typeof model.value !== 'string' || !model.value || models.some(m => m.id === model.value)) continue;
    models.push({ id: model.value, name: model.displayName || model.value,
      description: model.description || '', isDefault: model.value === 'default',
      efforts: Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.filter(e => typeof e === 'string') : [] });
  }
  if (!models.length) throw new Error(t('Claude Code returned no available models. Check its account and provider configuration.'));
  return models;
}

async function readLimits(binary, options) {
  // The installed Claude extension uses this experimental control request too.
  // Unsupported versions fail gracefully; no user/inference message is sent.
  return claudeLimits(await readControl(binary, { subtype: 'get_usage', skip_behaviors: true }, options));
}

module.exports = { extensionClaudePaths, listModels, readLimits };
