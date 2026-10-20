'use strict';

const { execFile } = require('node:child_process');
const { cliVersion } = require('./prerequisites');
const { t } = require('./l10n');

const AGENTS = {
  codex: { name: 'Codex', url: 'https://developers.openai.com/codex/cli/',
    status: ['login', 'status'], login: ['login'], logout: ['logout'] },
  claude: { name: 'Claude Code', url: 'https://code.claude.com/docs/en/overview',
    status: ['auth', 'status', '--json'], login: ['auth', 'login'], logout: ['auth', 'logout'] },
  auggie: { name: 'Auggie', url: 'https://docs.augmentcode.com/cli/setup-auggie/install-auggie-cli',
    status: ['account', 'status', '--json'], login: ['login'], logout: ['logout'] },
};

// Never propagate command output: status can contain email addresses and API keys.
function execute(binary, args, { signal, timeout = 15000 } = {}) {
  return new Promise(resolve => {
    execFile(binary, args, { signal, timeout, killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
      env: { ...process.env, AUGMENT_DISABLE_AUTO_UPDATE: '1', NO_COLOR: '1' } },
    (error, stdout, stderr) => resolve({ code: error ? error.code : 0, text: `${stdout}\n${stderr}`, stdout }));
  });
}

function connectionStatus(agent, result) {
  if (agent === 'claude') {
    try {
      const status = JSON.parse(result.stdout);
      if (typeof status.loggedIn === 'boolean') return status.loggedIn ? 'connected' : 'disconnected';
    } catch { /* An old client or offline check is not proof of a signed-out account. */ }
  } else if (result.code === 0) return 'connected';
  if (agent === 'auggie' && /account status.*not available for your current plan/i.test(result.text)) return 'connected';
  if (/not (?:currently )?logged in|not authenticated|please (?:log|sign) in|run ['"]?auggie login/i.test(result.text)) return 'disconnected';
  return 'unknown';
}

class AgentConnections {
  constructor(finders, changed, { run = execute, version = cliVersion, interval = 30000 } = {}) {
    this.finders = finders; this.changed = changed; this.run = run; this.interval = interval;
    this.version = version;
    this.entries = new Map(); this.pending = new Map(); this.disposed = false;
  }
  get(agent) { return { agent, status: 'checking', installed: false, ...this.entries.get(agent) }; }
  all() { return Object.keys(AGENTS).map(agent => this.get(agent)); }
  async refresh(agent, force = false) {
    if (this.disposed || !Object.hasOwn(AGENTS, agent)) return;
    if (this.pending.has(agent)) return this.pending.get(agent).promise;
    const prior = this.entries.get(agent);
    if (!force && prior && Date.now() - prior.checkedAt < this.interval) return;
    const controller = new AbortController();
    const pending = { controller };
    this.pending.set(agent, pending);
    pending.promise = (async () => {
      let binary;
      try { binary = await this.finders[agent](); } catch { /* Missing executable. */ }
      let status = 'missing', version;
      if (binary && !controller.signal.aborted) {
        const results = await Promise.allSettled([
          this.run(binary, AGENTS[agent].status, { signal: controller.signal }),
          this.version(binary, { signal: controller.signal }),
        ]);
        status = results[0].status === 'fulfilled' ? connectionStatus(agent, results[0].value) : 'unknown';
        version = results[1].status === 'fulfilled' ? results[1].value : undefined;
      }
      if (controller.signal.aborted || this.disposed) return;
      this.entries.set(agent, { installed: !!binary, status, version, checkedAt: Date.now() });
      this.changed();
    })().finally(() => { if (this.pending.get(agent) === pending) this.pending.delete(agent); });
    return pending.promise;
  }
  refreshAll(force = false) { return Promise.all(Object.keys(AGENTS).map(agent => this.refresh(agent, force))); }
  async logout(agent) {
    if (!Object.hasOwn(AGENTS, agent)) throw new Error('Unknown agent.');
    const binary = await this.finders[agent]();
    this.invalidate(agent);
    const result = await this.run(binary, AGENTS[agent].logout);
    await this.refresh(agent, true);
    if (result.code !== 0) throw new Error(t('{agent} could not sign out. Check the client installation and try again.', { agent: AGENTS[agent].name }));
  }
  invalidate(agent) {
    for (const key of agent ? [agent] : Object.keys(AGENTS)) {
      this.pending.get(key)?.controller.abort(); this.pending.delete(key); this.entries.delete(key);
    }
  }
  dispose() { this.disposed = true; this.invalidate(); }
}

module.exports = { AGENTS, AgentConnections, connectionStatus };
