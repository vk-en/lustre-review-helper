'use strict';

const { summarize } = require('./history');
const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// One snapshot per batch: replacing a live snapshot never adds the same tokens
// twice. This ledger is independent of the visible history and report files.
class UsageStatistics {
  constructor(saved = {}) {
    this.entries = new Map();
    this.excluded = new Set(saved.excluded || []);
    this.resetAt = saved.resetAt;
    for (const [id, entry] of Object.entries(saved.entries || {})) this.put(id, entry);
  }

  put(id, source) {
    if (this.excluded.has(id)) return false;
    const entry = { ...source, agent: source.agent || 'codex' };
    // Old windows and archive imports cannot resurrect pre-reset usage.
    if (this.resetAt && (!entry.startedAt && !entry.observedAt || (entry.startedAt || entry.observedAt) < this.resetAt)) return false;
    const previous = this.entries.get(id);
    // A crash can leave run.json older than the independently saved live usage.
    if (previous?.observedAt && entry.observedAt && entry.observedAt < previous.observedAt) return false;
    if (JSON.stringify(previous) === JSON.stringify(entry)) return false;
    this.entries.set(id, entry);
    return true;
  }

  merge(saved = {}) {
    for (const id of saved.excluded || []) { this.excluded.add(id); this.entries.delete(id); }
    for (const [id, entry] of Object.entries(saved.entries || {})) this.put(id, entry);
  }

  record(run) {
    const summary = summarize(run);
    const entry = { agent: run.agent, model: run.model || '', modelName: run.modelName || run.model || 'Unknown',
      tokens: summary.tokens, cost: summary.cost, credits: summary.credits,
      tokenPartial: summary.tokenPartial, costPartial: summary.costPartial,
      estimated: summary.costLabel !== 'Cost', startedAt: run.startedAt,
      observedAt: run.usage?.sampledAt || run.finishedAt || run.startedAt };
    return this.put(run.id, entry);
  }

  reset(runs = [], resetAt = this.resetAt) {
    // Keep reset runs excluded on reload/backfill, even if their files remain.
    for (const id of this.entries.keys()) this.excluded.add(id);
    for (const run of runs) this.excluded.add(run.id);
    this.entries.clear();
    this.resetAt = resetAt;
  }

  snapshot() {
    return { version: 2, entries: Object.fromEntries(this.entries), excluded: [...this.excluded], resetAt: this.resetAt };
  }

  rows() {
    const groups = new Map();
    for (const entry of this.entries.values()) {
      const key = JSON.stringify([entry.agent, entry.model]);
      if (!groups.has(key)) groups.set(key, { agent: entry.agent, model: entry.model, modelName: entry.modelName,
        tokens: null, cost: null, credits: null, tokenPartial: false, costPartial: false, creditsPartial: false, estimated: false });
      const row = groups.get(key);
      if ((!row.modelName || row.modelName === row.model) && entry.modelName) row.modelName = entry.modelName;
      for (const metric of ['tokens', 'cost', 'credits']) {
        if (known(entry[metric])) row[metric] = (row[metric] ?? 0) + entry[metric];
      }
      row.tokenPartial ||= !known(entry.tokens) || entry.tokenPartial;
      row.costPartial ||= !known(entry.cost) || entry.costPartial;
      row.creditsPartial ||= !known(entry.credits) || entry.costPartial;
      row.estimated ||= known(entry.cost) && entry.estimated;
    }
    return [...groups.values()].sort((a, b) => `${a.agent}\0${a.model}`.localeCompare(`${b.agent}\0${b.model}`));
  }
}

module.exports = { UsageStatistics };
