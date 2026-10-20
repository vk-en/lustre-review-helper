'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { executable } = require('./codex');
const { cliVersion } = require('./prerequisites');
const { t } = require('./l10n');

const GERRIT_URL = 'https://github.com/lustre-tools/llm_code_and_review_tools/tree/main/gerrit_cli';

async function findGerrit(explicit, lreview) {
  const candidates = [];
  if (!explicit && lreview) {
    const locations = [lreview];
    try { locations.push(await fs.realpath(lreview)); } catch { /* Try PATH. */ }
    for (const location of locations) for (const name of ['gerrit', 'gerrit-cli']) candidates.push(path.join(path.dirname(location), name));
  }
  try { return await executable('gerrit', explicit, candidates); }
  catch { if (explicit) throw new Error('Configured gerrit executable is unavailable.'); return executable('gerrit-cli'); }
}

// Match llm_tool_common.config.resolve_env_file. Used for older/missing CLIs,
// and for opening configuration before installation; never read file contents.
async function configFile(cwd, env = process.env, home = os.homedir()) {
  if (env.GERRIT_CLI_ENV_FILE) return path.resolve(cwd, env.GERRIT_CLI_ENV_FILE);
  const standard = path.join(home, '.config', 'gerrit-cli', '.env');
  for (const file of [standard, '/etc/gerrit-cli/.env', '/shared/support_files/.env', path.join(cwd, '.env')]) {
    try { await fs.access(file); return file; } catch { /* First existing file wins. */ }
  }
  return standard;
}

function probe(binary, cwd, { offline = false, signal, timeout = 15000 } = {}) {
  return new Promise(resolve => {
    execFile(binary, ['check', ...(offline ? ['--offline'] : [])], { cwd, signal, timeout,
      killSignal: 'SIGKILL', maxBuffer: 65536, env: { ...process.env, NO_COLOR: '1' } }, (error, stdout) => {
      let value;
      try { value = JSON.parse(stdout); } catch { /* Never expose raw diagnostics. */ }
      if (value?.error?.details) value = value.error.details;
      else if (value?.details) value = value.details;
      const allowed = ['connected', 'unchecked', 'unconfigured', 'disconnected', 'unavailable', 'error'];
      if (allowed.includes(value?.status) && typeof value.message === 'string' &&
          (value.status !== 'connected' || (!error && value.authenticated === true))) {
        resolve({ status: value.status, message: value.message,
          ...(typeof value.config_file === 'string' && path.isAbsolute(value.config_file) ? { configFile: value.config_file } : {}) });
      } else resolve({ status: 'unknown', message: error?.killed ? t('Connection check timed out. Try again.') :
        t('Connection check unavailable. Update gerrit-cli to a version with the check command, then retry.') });
    });
  });
}

class GerritConnection {
  constructor(find, changed, { run = probe, version = cliVersion, locate = configFile } = {}) {
    this.find = find; this.changed = changed; this.run = run; this.version = version; this.locate = locate;
    this.entry = { status: 'checking', installed: false }; this.disposed = false;
  }
  get(cwd) {
    return this.cwd && this.cwd !== cwd ? { ...this.entry, status: 'unchecked',
      message: t('Repository changed. Check the connection for this repository.'), configFile: undefined } : this.entry;
  }
  async refresh(cwd) {
    if (this.disposed) return;
    if (this.pending) {
      if (this.cwd === cwd) return this.pending;
      await this.pending;
      if (this.disposed) return;
    }
    this.cwd = cwd;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.entry = { ...this.entry, status: 'checking', pending: true }; this.changed();
    this.pending = (async () => {
      let binary, file;
      try { file = await this.locate(cwd); } catch { /* CLI probe can still locate it. */ }
      try { binary = await this.find(); } catch { /* Not installed. */ }
      let entry = { installed: !!binary, path: binary, configFile: file, status: 'missing', message: t('Install gerrit-cli to check the connection and publish reviews.') };
      if (binary && !signal.aborted) {
        const [version, check] = await Promise.allSettled([this.version(binary, { signal }), this.run(binary, cwd, { signal })]);
        entry = { ...entry, ...(check.status === 'fulfilled' ? check.value : { status: 'unknown', message: t('Connection check unavailable. Try again.') }),
          version: version.status === 'fulfilled' ? version.value : undefined };
      }
      if (!this.disposed && !signal.aborted) { this.entry = { ...entry, checkedAt: Date.now(), pending: false }; this.changed(); }
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  dispose() { this.disposed = true; this.controller?.abort(); }
}

function botName(value) {
  if (typeof value !== 'string' || value.length > 80 || /[\x00-\x1f\x7f\[\]<>]/.test(value)) {
    throw new Error(t('Bot name must be a single line of up to 80 characters, without brackets or angle brackets.'));
  }
  return value.trim();
}
module.exports = { GERRIT_URL, findGerrit, configFile, probe, GerritConnection, botName };
