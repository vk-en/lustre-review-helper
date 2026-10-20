'use strict';

const { summaryEntry } = require('./review-targets');

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { codexEstimate } = require('./pricing');

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const sum = values => values.some(v => v !== null) ? values.reduce((a, b) => a + (b || 0), 0) : null;
function tokens(usage, claude = false) {
  if (!usage || typeof usage !== 'object') return null;
  // Codex input already includes cached input; reasoning is part of output.
  return sum((claude ? ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] :
    ['input_tokens', 'output_tokens']).map(key => number(usage[key])));
}

class JsonlReader {
  constructor(consume, consumeText) { this.consume = consume; this.consumeText = consumeText; this.offset = 0; this.pending = Buffer.alloc(0); this.discarding = false; }
  async read(file) {
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (stat.size < this.offset) { this.offset = 0; this.pending = Buffer.alloc(0); this.discarding = false; }
      // Bound work per refresh; never reread a growing multi-megabyte log.
      const buffer = Buffer.alloc(Math.min(stat.size - this.offset, 4 * 1024 * 1024));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
      this.offset += bytesRead;
      let data = Buffer.concat([this.pending, buffer.subarray(0, bytesRead)]);
      let start = 0, end;
      while ((end = data.indexOf(10, start)) !== -1) {
        if (!this.discarding) {
          const line = data.subarray(start, end).toString('utf8');
          try { this.consume(JSON.parse(line)); } catch { this.consumeText?.(line); }
        }
        this.discarding = false;
        start = end + 1;
      }
      this.pending = Buffer.from(data.subarray(start));
      if (this.pending.length > 8 * 1024 * 1024) { this.pending = Buffer.alloc(0); this.discarding = true; }
      return stat;
    } finally { await handle.close(); }
  }
}

class LiveUsage {
  constructor(run, { codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    augmentHome = path.join(os.homedir(), '.augment'), claudeMetrics } = {}) {
    this.run = run;
    this.directory = path.join(run.directory, 'artifacts');
    this.codexHome = codexHome;
    this.augmentHome = augmentHome;
    this.claudeMetrics = claudeMetrics;
    this.workers = new Map();
    this.lastActivityAt = null;
  }

  worker() {
    const worker = { tokens: null, costUsd: null, credits: null, messages: new Map(), sessionTokens: null,
      estimatedCostUsd: null, model: this.run.model, previousUsage: {}, augmentRequests: new Map(), augmentBills: new Map() };
    worker.reader = new JsonlReader(event => {
      if (event.type === 'thread.started' && /^[a-f0-9-]{36}$/.test(event.thread_id)) worker.threadId = event.thread_id;
      if (event.type === 'system' && event.subtype === 'init') worker.sessionId = event.session_id;
      if (event.type === 'rate_limit_event') {
        const info = event.rate_limit_info || {};
        const windows = info.unifiedWindows || (info.rateLimitType ? { [info.rateLimitType]: info } : {});
        const limits = Object.entries(windows).flatMap(([key, window]) => {
          const minutes = { five_hour: 300, seven_day: 10080 }[key];
          const used = number(window?.utilization);
          return minutes && used !== null ? [{ minutes, usedPercent: used * 100, resetsAt: number(window.resetsAt) }] : [];
        });
        if (limits.length) worker.limits = { windows: limits, observedAt: new Date().toISOString() };
      }
      if (event.type === 'assistant' && event.message?.id && event.message.usage) {
        worker.messages.set(event.message.id, tokens(event.message.usage, true));
        worker.tokens = sum([...worker.messages.values()]);
      }
      if (event.type === 'turn.completed') worker.tokens = tokens(event.usage);
      if (event.type === 'result') {
        worker.tokens = tokens(event.usage, true) ?? worker.tokens;
        worker.costUsd = number(event.total_cost_usd) ?? worker.costUsd;
        if (event.billing?.usage_unit === 'usd') worker.costUsd = number(event.billing.total_cost);
        if (event.billing?.usage_unit === 'credits') worker.credits = number(event.billing.total_cost);
        worker.finalCostUsd = worker.costUsd;
        worker.finalCredits = worker.credits;
      }
    }, line => {
      if (this.run.agent !== 'auggie') return;
      // Anchor to this worker's own saved conversation, not the latest global session.
      const match = line.match(/^\d{4}-\d\d-\d\d .*\[info\] 'SessionManager': Session saved: ([a-f0-9-]{36})\s*$/) ||
        line.match(/^\d{4}-\d\d-\d\d .*\[info\] 'Setup-agentRuntime': Task manager initialized .* for conversation: ([a-f0-9-]{36})\s*$/);
      if (match && !worker.augmentSessionId) worker.augmentSessionId = match[1];
    });
    worker.sessionReader = new JsonlReader(event => {
      if (event.type === 'turn_context' && typeof event.payload?.model === 'string') worker.model = event.payload.model;
      if (event.type === 'event_msg' && event.payload?.type === 'token_count') {
        const usage = event.payload.info?.total_token_usage;
        worker.sessionTokens = tokens(usage) ?? worker.sessionTokens;
        if (usage && tokens(usage) !== tokens(worker.previousUsage)) {
          const delta = Object.fromEntries(['input_tokens', 'cached_input_tokens', 'output_tokens'].map(key =>
            [key, Math.max(0, (number(usage[key]) || 0) - (number(worker.previousUsage[key]) || 0))]));
          const cost = codexEstimate(worker.model, delta, {
            longContext: (event.payload.info?.last_token_usage?.input_tokens || 0) > 272000,
          });
          if (cost !== null) worker.estimatedCostUsd = (worker.estimatedCostUsd || 0) + cost;
          else worker.estimateIncomplete = true;
          worker.previousUsage = usage;
        }
        const rate = event.payload.rate_limits;
        if (rate) {
          const windows = [rate.primary, rate.secondary].filter(w => number(w?.used_percent) !== null && number(w?.window_minutes) !== null)
            .map(w => ({ minutes: w.window_minutes, usedPercent: w.used_percent, resetsAt: number(w.resets_at) }));
          if (windows.length) worker.limits = { windows, observedAt: event.timestamp || new Date().toISOString() };
        }
      }
    });
    return worker;
  }

  async augmentSession(worker) {
    if (!worker.augmentSessionId) return;
    const file = path.join(this.augmentHome, 'sessions', `${worker.augmentSessionId}.json`);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || stat.mtimeMs === worker.augmentMtime) return;
    const session = JSON.parse(await fs.readFile(file, 'utf8'));
    if (session.sessionId !== worker.augmentSessionId || !Array.isArray(session.chatHistory)) return;
    // Keep prior request totals across history compaction and deduplicate repeated nodes.
    for (const entry of session.chatHistory) {
      const exchange = entry.exchange;
      if (!exchange?.request_id) continue;
      for (const node of exchange.response_nodes || []) {
        if (node.type === 10 && node.token_usage) {
          const value = tokens(node.token_usage, true);
          if (value !== null) worker.augmentRequests.set(exchange.request_id, value);
        }
        const bill = node.type === 9 && node.billing_metadata;
        if (bill?.transaction_id) {
          const cost = bill.usage_unit === 2 && typeof bill.cost_usd === 'string' && bill.cost_usd.trim() ? number(Number(bill.cost_usd)) : null;
          worker.augmentBills.set(bill.transaction_id, { cost, credits: bill.usage_unit === 1 ? number(bill.credits_consumed) : null });
        }
      }
    }
    worker.tokens = sum([...worker.augmentRequests.values()]) ?? worker.tokens;
    const bills = [...worker.augmentBills.values()];
    worker.costUsd = sum(bills.map(b => b.cost)) ?? worker.costUsd;
    worker.credits = sum(bills.map(b => b.credits)) ?? worker.credits;
    if (worker.costUsd !== null) worker.costUsd += number(session.subAgentCostUsd) || 0;
    if (worker.credits !== null) worker.credits += number(session.subAgentCreditsUsed) || 0;
    worker.augmentPartial = (session.subAgentCostUsd || session.subAgentCreditsUsed || 0) > 0 ||
      session.chatHistory.some(entry => entry.exchange?.request_nodes?.some(node => node.history_summary_node));
    worker.augmentMtime = stat.mtimeMs;
    this.lastActivityAt = Math.max(this.lastActivityAt || 0, stat.mtimeMs);
  }

  async sessionFile(worker) {
    if (worker.sessionFile) return worker.sessionFile;
    if (!worker.threadId || Date.now() - (worker.searchedAt || 0) < 10000) return undefined;
    worker.searchedAt = Date.now();
    const dates = new Set();
    for (const time of [Date.parse(this.run.startedAt), Date.now()]) {
      for (const offset of [-86400000, 0, 86400000]) dates.add(new Date(time + offset).toISOString().slice(0, 10).replaceAll('-', '/'));
    }
    for (const date of dates) {
      const directory = path.join(this.codexHome, 'sessions', date);
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      const match = entries.find(e => e.isFile() && e.name.endsWith(`-${worker.threadId}.jsonl`));
      if (match) { worker.sessionFile = path.join(directory, match.name); return worker.sessionFile; }
    }
    return undefined;
  }

  async poll() {
    const entries = await fs.readdir(this.directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
      let worker = this.workers.get(entry.name);
      if (!worker) { worker = this.worker(); this.workers.set(entry.name, worker); }
      try {
        const previousLimits = worker.limits;
        const stat = await worker.reader.read(path.join(this.directory, entry.name));
        if (worker.limits && worker.limits !== previousLimits) worker.limits.observedAt = new Date(stat.mtimeMs).toISOString();
        if (stat.size) this.lastActivityAt = Math.max(this.lastActivityAt || 0, stat.mtimeMs);
        if (this.run.agent === 'codex') {
          const session = await this.sessionFile(worker);
          if (session) {
            const sessionStat = await worker.sessionReader.read(session);
            worker.sessionBacklog = sessionStat.size > worker.sessionReader.offset;
            this.lastActivityAt = Math.max(this.lastActivityAt || 0, sessionStat.mtimeMs);
          }
        }
        if (this.run.agent === 'auggie') await this.augmentSession(worker);
      } catch { /* Missing session telemetry must not interrupt the review. */ }
    }
    let summary = {};
    try {
      const file = path.join(this.directory, 'summary.json');
      const stat = await fs.lstat(file);
      if (stat.isFile() && stat.size < 16 * 1024 * 1024) summary = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch { /* Not created yet, or being replaced. */ }
    const done = this.run.commits.flatMap(key => {
      const entry = summaryEntry(summary || {}, key, this.run.gerritPatches);
      return entry ? [{...entry, target:key}] : [];
    });
    const measurements = [...this.workers.entries()].map(([name, w]) => {
      const completed = done.find(e => e.log === name);
      return { sha: completed?.target, tokens: number(completed?.tokens) ?? w.tokens ?? w.sessionTokens,
        cost: number(completed?.cost_usd) ?? w.finalCostUsd ?? w.costUsd ?? this.claudeMetrics?.cost(w.sessionId) ?? null,
        estimated: w.estimatedCostUsd, credits: w.finalCredits ?? w.credits,
        tokensPartial: !!w.augmentPartial || (w.tokens === null && !!w.sessionBacklog),
        costPartial: !!w.estimateIncomplete || !!w.sessionBacklog };
    });
    for (const entry of done) if (!this.workers.has(entry.log)) measurements.push({sha:entry.target,tokens:number(entry.tokens), cost:number(entry.cost_usd), credits:null});
    const knownTokens = measurements.filter(m => m.tokens !== null).length;
    const knownCost = measurements.filter(m => m.cost !== null || m.credits !== null || number(m.estimated) !== null).length;
    const limits = [...this.workers.values()].map(w => w.limits).filter(Boolean).sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
    return { byCommit: Object.fromEntries(measurements.filter(m => m.sha).map(m => [m.sha, {
      tokens: m.tokens, costUsd: m.cost, estimatedCostUsd: m.cost === null ? m.estimated ?? null : null,
      credits: m.credits, tokensPartial: !!m.tokensPartial, costPartial: !!m.costPartial,
    }])), tokens: sum(measurements.map(m => m.tokens)), costUsd: sum(measurements.map(m => m.cost)),
      estimatedCostUsd: measurements.some(m => number(m.estimated) !== null && m.cost === null) ?
        sum(measurements.map(m => m.cost ?? m.estimated ?? null)) : null,
      credits: sum(measurements.map(m => m.credits)),
      tokensPartial: knownTokens < this.run.commits.length || measurements.some(m => m.tokensPartial),
      costPartial: knownCost < this.run.commits.length || measurements.some(m => m.costPartial), limits,
      completed: new Set(done.map(e => e.target)).size, total: this.run.commits.length,
      lastActivityAt: this.lastActivityAt ? new Date(this.lastActivityAt).toISOString() : null,
      sampledAt: new Date().toISOString() };
  }
}

module.exports = { LiveUsage, JsonlReader, tokens };
