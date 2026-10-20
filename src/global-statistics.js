'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { UsageStatistics } = require('./statistics');
const { fileLock } = require('./file-lock');
const { t } = require('./l10n');

// Windows share one ledger in globalStorage. A short filesystem lock protects
// read/merge/rename transactions; each window only submits its changed runs.
class GlobalStatistics {
  constructor({ file, workspaceStorage, extensionId }) {
    this.file = file;
    this.workspaceStorage = workspaceStorage;
    this.extensionId = extensionId;
    this.statistics = new UsageStatistics();
    this.pending = new Map();
    this.queue = Promise.resolve();
  }

  async archive() {
    if (!this.workspaceStorage) return [];
    const runs = [];
    const workspaces = await fs.readdir(this.workspaceStorage, { withFileTypes: true }).catch(() => []);
    for (const workspace of workspaces) {
      if (!workspace.isDirectory() || !/^[a-f0-9]{32}$/.test(workspace.name)) continue;
      const directory = path.join(this.workspaceStorage, workspace.name, this.extensionId, 'runs');
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
        try {
          const file = path.join(directory, entry.name, 'run.json');
          const stat = await fs.lstat(file);
          if (!stat.isFile() || stat.size > 16 * 1024 * 1024) continue;
          const { log, ...run } = JSON.parse(await fs.readFile(file, 'utf8'));
          if (run.id === entry.name && Array.isArray(run.commits) && run.commits.every(sha => /^[a-f0-9]{40,64}$/.test(sha))) runs.push(run);
        } catch { /* One incomplete archive must not hide the other projects. */ }
      }
    }
    return runs;
  }

  async initialize({ legacy, runs = [] } = {}) {
    const archive = await this.archive();
    await this.transaction(stats => {
      stats.merge(legacy);
      for (const run of [...archive, ...runs]) stats.record(run);
    });
  }

  record(run) {
    if (!this.statistics.record(run)) return false;
    this.pending.set(run.id, this.statistics.entries.get(run.id));
    return true;
  }

  rows() { return this.statistics.rows(); }

  lock() { return fileLock(this.file, t('Usage statistics are busy in another VS Code window. Try again shortly.')); }

  transaction(change = () => {}) {
    const operation = this.queue.catch(() => {}).then(async () => {
      const release = await this.lock();
      try {
        let saved;
        try { saved = JSON.parse(await fs.readFile(this.file, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const stats = new UsageStatistics(saved);
        const updates = new Map(this.pending);
        for (const [id, entry] of updates) stats.put(id, entry);
        change(stats);
        const serialized = JSON.stringify(stats.snapshot());
        if (serialized !== JSON.stringify(saved)) {
          const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
          try {
            await fs.writeFile(temporary, serialized, { mode: 0o600 });
            await fs.rename(temporary, this.file);
          } finally { await fs.unlink(temporary).catch(() => {}); }
        }
        for (const [id, entry] of updates) if (this.pending.get(id) === entry) this.pending.delete(id);
        // Telemetry may arrive during the write. Keep those newer local values.
        for (const [id, entry] of this.pending) stats.put(id, entry);
        this.statistics = stats;
      } finally { await release(); }
    });
    this.queue = operation;
    return operation;
  }

  sync() { return this.transaction(); }
  reset() { return this.transaction(stats => stats.reset([], new Date().toISOString())); }
}

module.exports = { GlobalStatistics };
