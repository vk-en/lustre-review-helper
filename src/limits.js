'use strict';

const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const window = (minutes, usedPercent, resetsAt, label) => finite(minutes) && minutes > 0 && finite(usedPercent) ?
  [{ minutes, usedPercent, resetsAt: finite(resetsAt) ? resetsAt : null, ...(label ? { label } : {}) }] : [];
const snapshot = windows => windows.length ? { windows, observedAt: new Date().toISOString() } : null;

function codexLimits(response) {
  const rate = response?.rateLimitsByLimitId?.codex || response?.rateLimits;
  return snapshot([rate?.primary, rate?.secondary].flatMap(w =>
    window(w?.windowDurationMins, w?.usedPercent, w?.resetsAt)));
}

function claudeLimits(response) {
  const rate = response?.rate_limits;
  const parse = (w, minutes, label) => window(minutes, w?.utilization,
    typeof w?.resets_at === 'string' ? Date.parse(w.resets_at) / 1000 : null, label);
  return snapshot([
    ...parse(rate?.five_hour, 300), ...parse(rate?.seven_day, 10080),
    ...(Array.isArray(rate?.model_scoped) ? rate.model_scoped.flatMap(w =>
      parse(w, 10080, `Weekly · ${w.model_name || w.model || 'model-specific'}`)) : []),
  ]);
}

// Keep account-wide limits separate from a review's token/cost statistics.
// Only numeric snapshots are retained; the clients handle their own credentials.
class AccountLimits {
  constructor(readers, changed, { interval = 60000, now = Date.now } = {}) {
    this.readers = readers; this.changed = changed; this.interval = interval; this.now = now;
    this.entries = new Map(); this.controllers = new Map(); this.disposed = false;
  }
  get(agent) { return { agent, ...this.entries.get(agent) }; }
  seed(agent, limits) {
    if (!this.readers[agent] || !limits?.windows?.length) return;
    const entry = this.entries.get(agent) || {};
    const observedAt = entry.snapshot?.observedAt || entry.checkedAt;
    if (!observedAt || Date.parse(limits.observedAt) > Date.parse(observedAt)) {
      this.entries.set(agent, { ...entry, snapshot: limits, source: 'review' });
    }
  }
  async refresh(agent) {
    if (this.disposed || !this.readers[agent] || this.controllers.has(agent)) return;
    const entry = this.entries.get(agent) || {};
    if (entry.attemptedAt !== undefined && this.now() - entry.attemptedAt < this.interval) return;
    const controller = new AbortController(); this.controllers.set(agent, controller);
    this.entries.set(agent, { ...entry, loading: true, attemptedAt: this.now() }); this.changed();
    try {
      const result = await this.readers[agent]({ signal: controller.signal });
      if (!controller.signal.aborted) this.entries.set(agent, { snapshot: result, source: 'account', loading: false,
        checkedAt: new Date(this.now()).toISOString(), attemptedAt: this.now(), error: false });
    } catch {
      if (!controller.signal.aborted) this.entries.set(agent, { ...this.entries.get(agent), loading: false,
        attemptedAt: this.now(), error: true });
    } finally {
      if (this.controllers.get(agent) === controller) this.controllers.delete(agent);
      if (!this.disposed && !controller.signal.aborted) this.changed();
    }
  }
  invalidate() {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear(); this.entries.clear();
  }
  dispose() { this.disposed = true; this.invalidate(); }
}

module.exports = { codexLimits, claudeLimits, AccountLimits };
