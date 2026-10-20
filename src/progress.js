'use strict';

// Progress of each review in a batch, read from lreview's log lines as they
// arrive. lreview writes its summary only when the whole batch ends, but it
// logs every review it starts and finishes:
//   [66891_ps10] review started: <subject>
//   [66891_ps10] 2 finding(s), severity low (8m18s, $3.34) -> gerrit-review-66891_ps10.json
//   [66891_ps10] clean — no findings (8m18s, 1.2M tok, $3.34)
//   [66891_ps10] FAILED (claude exited 1), see <log>
//   running: 66891_ps10 1m00s 78KB, 66893_ps12 1m00s 77KB | done 0/4
const SHA = /^[a-f0-9]{40,64}$/;
const STARTED = /^\[([^\]\s]+)\] review started\b/;
const FINDINGS = /^\[([^\]\s]+)\] (\d+) finding\(s\)(?:, severity ([\w-]+))? \(([^)]*)\)/;
const CLEAN = /^\[([^\]\s]+)\] clean\b[^(]*\(([^)]*)\)/;
const FAILED = /^\[([^\]\s]+)\] FAILED\b/;
const RUNNING = /^running: (.+?) \| done \d+\/\d+\s*$/;
const DONE = new Set(['clean', 'findings', 'failed']);

// lreview writes elapsed time as <minutes>m<seconds>s, e.g. 75m03s.
function seconds(text) {
  const match = /(\d+)m(\d{1,2})s/.exec(text || '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}
function stats(text) {
  const cost = /\$(\d+(?:\.\d+)?)/.exec(text || '');
  return { duration: seconds(text), ...(cost ? { costUsd: Number(cost[1]) } : {}) };
}

class BatchProgress {
  constructor(run, now = Date.now) {
    this.run = run; this.now = now; this.rest = '';
    run.progress ||= { items: {} };
  }

  // lreview names a Gerrit review <change>_ps<patchset> and a local one
  // <ref>_<first 7 hex digits of the commit>.
  target(slug) {
    for (const key of this.run.commits || []) {
      const patch = this.run.gerritPatches?.find(item => item.id === key);
      if (patch ? slug === `${patch.number}_ps${patch.patchset}` : SHA.test(key) && slug.endsWith(`_${key.slice(0, 7)}`)) return key;
    }
    return undefined;
  }

  item(slug) {
    const key = this.target(slug);
    if (!key) return undefined;
    return (this.run.progress.items[key] ||= { state: 'queued' });
  }

  // Feeds a chunk of output; returns whether any review changed state.
  feed(chunk) {
    const lines = (this.rest + String(chunk)).split(/\r\n|\r|\n/);
    this.rest = lines.pop();
    if (this.rest.length > 4096) this.rest = '';
    let changed = false;
    for (const line of lines) changed = this.line(line.trim()) || changed;
    return changed;
  }

  line(line) {
    const at = new Date(this.now()).toISOString();
    let match;
    if ((match = STARTED.exec(line))) {
      const item = this.item(match[1]);
      if (!item) return false;
      // A stalled review is retried: it starts again, with a fresh clock.
      Object.assign(item, { state: 'running', startedAt: at });
      delete item.finishedAt; delete item.duration;
      return true;
    }
    const result = (match = FINDINGS.exec(line)) ? { state: 'findings', findings: Number(match[2]), ...(match[3] ? { severity: match[3] } : {}), ...stats(match[4]) } :
      (match = CLEAN.exec(line)) ? { state: 'clean', findings: 0, ...stats(match[2]) } :
      (match = FAILED.exec(line)) ? { state: 'failed' } : undefined;
    if (result) {
      const item = this.item(match[1]);
      if (!item) return false;
      if (result.duration === undefined && item.startedAt) result.duration = Math.round((Date.parse(at) - Date.parse(item.startedAt)) / 1000);
      Object.assign(item, result, { finishedAt: at });
      return true;
    }
    if ((match = RUNNING.exec(line))) {
      let changed = false;
      for (const part of match[1].split(', ')) {
        const [slug, elapsed] = part.split(' ');
        const item = this.item(slug), running = seconds(elapsed);
        if (!item || DONE.has(item.state) || running === undefined) continue;
        // Joined midway: the status line says how long the review has run.
        if (item.state !== 'running' || !item.startedAt) {
          Object.assign(item, { state: 'running', startedAt: new Date(this.now() - running * 1000).toISOString() });
          changed = true;
        }
      }
      return changed;
    }
    return false;
  }

  get done() { return Object.values(this.run.progress.items).filter(item => DONE.has(item.state)).length; }
}

module.exports = { BatchProgress, seconds };
