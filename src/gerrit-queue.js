'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileLock } = require('./file-lock');
const { t } = require('./l10n');

// The changes where the Gerrit account is a reviewer, for the Waiting Review
// and In progress tabs. gerrit-dashboard reads Gerrit once per refresh: votes,
// CI state and patchset history. Owner replies come from gerrit-cli's comment
// timeline. The last snapshot of each project is shared by all windows.
const ORIGIN = 'https://review.whamcloud.com';
const PROJECT = /^[\w.-]+(?:\/[\w.-]+)*$/;
const validProject = name => typeof name === 'string' && name.length <= 200 && PROJECT.test(name) && !name.split('/').some(part => part === '.' || part === '..');
// Ready for landing: CI passed, no negative vote and two positive votes from
// people other than the owner.
const READY_VOTES = 2;
const PROJECT_LIMIT = 20;
// Refreshed by itself this often, by whichever window of the project gets there first.
const AUTO_REFRESH = 5 * 60 * 1000;
const FILTERS = {
  waiting: ['ciFailed', 'ciRunning', 'plusOther', 'negOther', 'ready'],
  progress: ['noUpdates', 'mine', 'ciFailed', 'ciRunning', 'ready', 'negOther'],
};
const DEFAULT_FILTERS = { waiting: ['ciFailed', 'ciRunning'], progress: ['mine', 'ciFailed', 'ciRunning'] };
const KINDS = ['waiting', 'newps', 'replied', 'author', 'mine'];
const CI = ['passed', 'running', 'failed'];
const STEPS = ['passed', 'running', 'failed', 'none'];

const text = (value, max = 300) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max) : '';
const integer = (value, min = 1) => Number.isSafeInteger(value) && value >= min ? value : undefined;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : undefined;

// Gerrit writes UTC as 'YYYY-MM-DD HH:MM:SS.nnnnnnnnn'.
function gerritTime(value) {
  const match = typeof value === 'string' && value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (!match) return undefined;
  const time = Date.parse(`${match[1]}T${match[2]}Z`);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function refreshDashboard(binary, { dataDir, project, cwd, signal, timeout = 300000 }) {
  return new Promise((resolve, reject) => {
    execFile(binary, ['refresh', '--projects', project], { cwd, signal, timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
      // Credentials stay with gerrit-cli's configuration; pin the server.
      env: { ...process.env, GD_DATA_DIR: dataDir, GERRIT_URL: ORIGIN, NO_COLOR: '1' } }, error => {
      // Never forward raw output: it can contain credentials.
      if (!error) { resolve(); return; }
      // The code tells the view which fix to offer next to the message.
      const [message, code] = error.name === 'AbortError' ? [t('Refreshing Gerrit reviews was cancelled.'), 'cancelled'] :
        error.killed ? [t('Refreshing Gerrit reviews timed out. Check your connection or VPN, then refresh.'), 'timeout'] :
        error.code === 2 ? [t('gerrit-dashboard cannot tell which Gerrit account is yours. Set GERRIT_USER in the Gerrit CLI configuration, then refresh.'), 'account'] :
        [t('Could not read your reviews from Gerrit. Check the Gerrit connection in AI Settings, then refresh.'), 'gerrit'];
      reject(Object.assign(new Error(message), { code }));
    });
  });
}

// gerrit-dashboard writes users/<account>/snapshot.json under its data directory.
async function latestSnapshot(dataDir) {
  const users = path.join(dataDir, 'users');
  let best;
  for (const entry of await fs.readdir(users, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const file = path.join(users, entry.name, 'snapshot.json');
    const stat = await fs.lstat(file).catch(() => null);
    if (stat?.isFile() && stat.size <= 64 * 1024 * 1024 && (!best || stat.mtimeMs > best.mtimeMs)) best = { file, mtimeMs: stat.mtimeMs };
  }
  if (!best) throw new Error(t('gerrit-dashboard saved no review data. Update gerrit-dashboard, then refresh.'));
  try { return JSON.parse(await fs.readFile(best.file, 'utf8')); }
  catch { throw new Error(t('gerrit-dashboard saved unreadable review data. Update gerrit-dashboard, then refresh.')); }
}

function readTimeline(binary, number, cwd, { signal, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(binary, ['comments', `${ORIGIN}/${number}`, '--all', '--no-context', '--timeline'], {
      cwd, signal, timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GERRIT_URL: ORIGIN, NO_COLOR: '1' },
    }, (error, stdout) => {
      if (error) { reject(new Error('Could not read Gerrit comments.')); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Gerrit CLI returned invalid comments.')); }
    });
  });
}

// The newest comment by the owner after my last message, from a timeline.
// Patchset-level replies count: Gerrit keeps reply text as such a comment.
function ownerReply(data, owner, since) {
  if (!owner) return undefined;
  let latest;
  for (const entry of Array.isArray(data?.timeline) ? data.timeline : []) {
    if (text(entry?.author, 200) !== owner) continue;
    const at = gerritTime(entry.updated);
    if (at && (!since || at > since) && (!latest || at > latest)) latest = at;
  }
  return latest;
}

function ciState(record) {
  const build = { SUCCESS: 'passed', FAILURE: 'failed', BUILDING: 'running' }[record.build?.state] || 'none';
  const state = record.test?.state;
  // Failures that are all being retested again count as still running.
  const tests = state === 'PASS' ? 'passed' : state === 'FAIL' ? record.test?.all_failures_retesting === true ? 'running' : 'failed' :
    state === 'RUNNING' ? 'running' : 'none';
  const failed = build === 'failed' || tests === 'failed' || record.gate === 'FAIL';
  return { build, tests, ci: failed ? 'failed' : record.gate === 'OK' ? 'passed' : 'running',
    failedTests: (Array.isArray(record.test?.failed_tests) ? record.test.failed_tests : []).map(test => text(test?.name, 120)).filter(Boolean).slice(0, 5) };
}

// One change where I am a reviewer; undefined when it does not belong here.
function change(record, me, project) {
  const number = integer(record?.number), ps = integer(record?.ps);
  if (!number || !ps || record.project !== project || record.status !== 'NEW' || record.wip === true || record.owner_id === me) return undefined;
  const review = record.review || {};
  const votes = (Array.isArray(review.humans) ? review.humans : [])
    .filter(vote => Number.isSafeInteger(vote?.value) && vote.value !== 0 && vote.account_id !== record.owner_id)
    .map(vote => ({ name: text(vote.name, 200) || 'Gerrit user', value: Math.max(-2, Math.min(2, vote.value)), ...(vote.account_id === me ? { me: true } : {}) }));
  const others = votes.filter(vote => !vote.me);
  const myVote = Number.isSafeInteger(review.my_vote) ? Math.max(-2, Math.min(2, review.my_vote)) : 0;
  const prior = integer(review.prior_vote?.ps) && Number.isSafeInteger(review.prior_vote?.value) ?
    { ps: review.prior_vote.ps, value: Math.max(-2, Math.min(2, review.prior_vote.value)) } : undefined;
  // My last message, vote or comment. Its patchset is the one current then.
  const mine = gerritTime(record.activity?.me);
  const uploads = (Array.isArray(record.ps_history) ? record.ps_history : []).map(entry => ({ ps: integer(entry?.ps), at: gerritTime(entry?.date) }))
    .filter(entry => entry.ps && entry.at);
  const atMine = mine ? uploads.filter(entry => entry.at <= mine).reduce((best, entry) => Math.max(best, entry.ps), 0) : 0;
  const reviewed = myVote !== 0 || !!prior || !!mine;
  const myPs = !reviewed ? undefined : myVote !== 0 ? ps : Math.min(ps, Math.max(prior?.ps || 0, atMine)) || ps;
  const negative = review.neg === true || votes.some(vote => vote.value < 0);
  const ci = ciState(record);
  return { number, ps, subject: text(record.subject) || `Change ${number}`, owner: text(record.owner, 200), branch: text(record.branch, 200),
    updated: gerritTime(record.updated), psCreated: gerritTime(record.ps_created), reviewed, myVote, ...(myPs ? { myPs } : {}),
    ...(prior ? { prior } : {}), ...(mine ? { lastMine: mine } : {}), ...ci, votes,
    unresolved: integer(record.unresolved, 0) || 0, plusOther: others.some(vote => vote.value > 0), negOther: others.some(vote => vote.value < 0),
    ready: ci.ci === 'passed' && !negative && votes.filter(vote => vote.value > 0).length >= READY_VOTES };
}

// AI reviews in a comment timeline: comments signed as lreview signs them,
// '[AI review - opus]' or a bot name, bold or plain, or by the Lustre AI
// review bot. A bracket alone is not enough: '[nit]' is a reviewer's note.
const AI_BOTS = new Set(['Gerrit AI review for Lustre', 'aireview']);
const SIGNATURE = /^\s*(?:\*\*)?\\?\[([^\]\n]{1,120}?)\\?\](?:\*\*)?(?:\s|$)/;
const AI_WORDS = /\b(?:ai|bot|review|llm|claude|codex|gpt|opus|sonnet|haiku|fable|gemini|augment|auggie)\b/i;
function aiReviews(data, patchset) {
  const groups = new Map();
  for (const entry of Array.isArray(data?.timeline) ? data.timeline : []) {
    const ps = Number(entry?.patch_set);
    if (!Number.isSafeInteger(ps) || (patchset !== undefined && ps !== patchset)) continue;
    const author = text(entry.author, 200) || 'Gerrit user';
    const signed = typeof entry.message === 'string' ? entry.message.match(SIGNATURE)?.[1]?.trim() : undefined;
    const signature = signed && AI_WORDS.test(signed) ? text(signed, 120) : AI_BOTS.has(author) ? author : undefined;
    const at = gerritTime(entry.updated);
    if (!signature || !at) continue;
    const key = `${ps}\n${author}\n${signature}`;
    const group = groups.get(key) || { patchset: ps, author, signature, count: 0, at };
    group.count++;
    if (at > group.at) group.at = at;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.at.localeCompare(b.at) || a.author.localeCompare(b.author));
}

// Kind and filter flags, once owner replies are known.
function finish(item) {
  const mine = item.reviewed && item.myVote > 0;
  const kind = !item.reviewed ? 'waiting' : mine ? 'mine' : item.myPs < item.ps ? 'newps' : item.replyAt ? 'replied' : 'author';
  return { ...item, kind, mine, noUpdates: item.reviewed && item.myPs === item.ps && !item.replyAt,
    ciFailed: item.ci === 'failed', ciRunning: item.ci === 'running' };
}

const CI_RANK = { passed: 0, running: 1, failed: 2 };
const KIND_RANK = { newps: 0, replied: 1, author: 2, mine: 3 };
const eventTime = item => (item.kind === 'newps' ? item.psCreated : item.kind === 'replied' ? item.replyAt : item.updated) || '';
const order = {
  waiting: (a, b) => CI_RANK[a.ci] - CI_RANK[b.ci] || (b.updated || '').localeCompare(a.updated || '') || a.number - b.number,
  progress: (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || eventTime(b).localeCompare(eventTime(a)) || a.number - b.number,
};

function classify(snapshot, project) {
  const me = snapshot?.self?.account_id;
  if (!Number.isSafeInteger(me) || !snapshot.reviews || typeof snapshot.reviews !== 'object') {
    throw new Error(t('gerrit-dashboard returned review data in an unknown format. Update gerrit-dashboard, then refresh.'));
  }
  if (Array.isArray(snapshot.projects) && snapshot.projects.length && !snapshot.projects.includes(project)) {
    throw new Error(t('gerrit-dashboard returned reviews of another project instead of {project}. Refresh again.', { project }));
  }
  const seen = new Set(), waiting = [], progress = [];
  for (const records of Object.values(snapshot.reviews)) {
    for (const record of Array.isArray(records) ? records : []) {
      const item = change(record, me, project);
      if (!item || seen.has(item.number)) continue;
      seen.add(item.number);
      (item.reviewed ? progress : waiting).push(item);
    }
  }
  return { account: text(snapshot.self.name, 200) || text(snapshot.self.username, 200), waiting, progress };
}

// Saved entries are re-checked on load: the file is shared by every window.
function restore(item) {
  if (!item || typeof item !== 'object') return undefined;
  const number = integer(item.number), ps = integer(item.ps);
  if (!number || !ps || !KINDS.includes(item.kind) || !CI.includes(item.ci)) return undefined;
  const votes = (Array.isArray(item.votes) ? item.votes : []).filter(vote => Number.isSafeInteger(vote?.value) && vote.value !== 0).slice(0, 30)
    .map(vote => ({ name: text(vote.name, 200) || 'Gerrit user', value: Math.max(-2, Math.min(2, vote.value)), ...(vote.me === true ? { me: true } : {}) }));
  const prior = integer(item.prior?.ps) && Number.isSafeInteger(item.prior?.value) ? { ps: item.prior.ps, value: Math.max(-2, Math.min(2, item.prior.value)) } : undefined;
  const flags = Object.fromEntries(['reviewed', 'plusOther', 'negOther', 'ready', 'mine', 'noUpdates', 'ciFailed', 'ciRunning', 'replyUnknown', 'aiChecked'].map(key => [key, item[key] === true]));
  const aiOthers = (Array.isArray(item.aiOthers) ? item.aiOthers : []).slice(0, 10).flatMap(entry => {
    const at = iso(entry?.at), count = integer(entry?.count);
    return at && count ? [{ author: text(entry.author, 200) || 'Gerrit user', signature: text(entry.signature, 120), count, at }] : [];
  });
  return { number, ps, subject: text(item.subject) || `Change ${number}`, owner: text(item.owner, 200), branch: text(item.branch, 200),
    ...Object.fromEntries(['updated', 'psCreated', 'lastMine', 'replyAt'].map(key => [key, iso(item[key])]).filter(([, value]) => value)),
    myVote: Number.isSafeInteger(item.myVote) ? Math.max(-2, Math.min(2, item.myVote)) : 0, ...(integer(item.myPs) ? { myPs: item.myPs } : {}),
    ...(prior ? { prior } : {}), ci: item.ci, build: STEPS.includes(item.build) ? item.build : 'none', tests: STEPS.includes(item.tests) ? item.tests : 'none',
    failedTests: (Array.isArray(item.failedTests) ? item.failedTests : []).map(name => text(name, 120)).filter(Boolean).slice(0, 5),
    votes, unresolved: integer(item.unresolved, 0) || 0, kind: item.kind, ...(aiOthers.length ? { aiOthers } : {}), ...flags };
}

function restoreProject(entry) {
  if (!entry || !iso(entry.refreshedAt)) return undefined;
  const list = values => (Array.isArray(values) ? values : []).map(restore).filter(Boolean);
  const waiting = list(entry.waiting).filter(item => item.kind === 'waiting');
  const progress = list(entry.progress).filter(item => item.kind !== 'waiting');
  return { refreshedAt: iso(entry.refreshedAt), account: text(entry.account, 200), waiting, progress };
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

class GerritQueue {
  constructor({ file, dataDir, findDashboard, findGerrit, changed = () => {}, refresh = refreshDashboard, timeline = readTimeline, now = Date.now }) {
    Object.assign(this, { file, dataDir, findDashboard, findGerrit, changed, refreshCommand: refresh, timeline, now });
    this.projects = {};
    this.pending = new Map();
    this.errors = new Map();
    this.version = undefined;
  }

  async load() {
    const stat = await fs.stat(this.file).catch(() => null);
    if (!stat) { this.projects = {}; this.version = undefined; return; }
    let data;
    try { data = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch { return; }
    const projects = {};
    for (const [project, entry] of Object.entries(data?.projects && typeof data.projects === 'object' ? data.projects : {})) {
      const restored = validProject(project) && restoreProject(entry);
      if (restored) projects[project] = restored;
    }
    this.projects = projects; this.version = stat.mtimeMs;
  }

  // Picks up a refresh made in another window. Writes replace the file by
  // rename, so a read without the lock always sees a whole file.
  async reload() {
    const stat = await fs.stat(this.file).catch(() => null);
    if ((stat?.mtimeMs) === this.version) return false;
    await this.load();
    return true;
  }

  get(project) {
    const saved = project ? this.projects[project] : undefined;
    const error = project ? this.errors.get(project) : undefined;
    return { refreshing: !!project && this.pending.has(project), error: error?.message, ...(error?.code ? { errorCode: error.code } : {}),
      loaded: !!saved, refreshedAt: saved?.refreshedAt, account: saved?.account, waiting: saved?.waiting || [], progress: saved?.progress || [] };
  }

  // An automatic refresh never waits for another window: if one is already
  // refreshing the project, or did so recently, this window leaves it alone.
  refresh(project, cwd, { auto = false } = {}) {
    if (!validProject(project)) return Promise.resolve();
    if (this.pending.has(project)) return this.pending.get(project);
    if (!auto) this.errors.delete(project);
    const pending = this.run(project, cwd, auto)
      .catch(error => { this.errors.set(project, { message: error.message, ...(typeof error.code === 'string' ? { code: error.code } : {}) }); })
      .finally(() => { this.pending.delete(project); this.changed(); });
    this.pending.set(project, pending);
    this.changed();
    return pending;
  }

  async run(project, cwd, auto = false) {
    const dashboard = await this.findDashboard().catch(() => {
      throw Object.assign(new Error(t('Install gerrit-dashboard to list the changes where you are a reviewer. See AI Settings → Utilities.')), { code: 'dashboard' });
    });
    // One data directory per project: windows on other projects never share a snapshot.
    const dataDir = path.join(this.dataDir, crypto.createHash('sha256').update(project).digest('hex').slice(0, 16));
    let release;
    try { release = await fileLock(path.join(dataDir, 'refresh'), t('Another VS Code window is refreshing these Gerrit reviews. Try again shortly.'), { timeout: auto ? 0 : 330000 }); }
    catch (error) { if (auto) return; throw error; }
    try {
      await this.reload();
      const previous = this.projects[project];
      // Another window refreshed this project while this one waited, or, for
      // an automatic refresh, within the last interval.
      if (previous && this.now() - Date.parse(previous.refreshedAt) < (auto ? AUTO_REFRESH - 30000 : 20000)) return;
      if (auto) this.errors.delete(project);
      await this.refreshCommand(dashboard, { dataDir, project, cwd });
      const result = classify(await latestSnapshot(dataDir), project);
      // Comments, read again only for changes updated since the last refresh:
      // owner replies for In progress, and other people's AI reviews of the
      // current patchset for both lists.
      const known = new Map([...(previous?.waiting || []), ...(previous?.progress || [])].map(item => [item.number, item]));
      const gerrit = await this.findGerrit().catch(() => undefined);
      await mapLimit([...result.waiting, ...result.progress], 5, async item => {
        const old = known.get(item.number);
        if (old && old.aiChecked && !old.replyUnknown && old.ps === item.ps && old.updated === item.updated && old.lastMine === item.lastMine) {
          if (item.reviewed && old.replyAt) item.replyAt = old.replyAt;
          if (old.aiOthers) item.aiOthers = old.aiOthers;
          item.aiChecked = true;
          return;
        }
        if (!gerrit) { item.replyUnknown = true; return; }
        try {
          const data = await this.timeline(gerrit, item.number, cwd);
          const reply = item.reviewed ? ownerReply(data, item.owner, item.lastMine) : undefined;
          if (reply) item.replyAt = reply;
          const others = aiReviews(data, item.ps).filter(review => review.author !== result.account)
            .map(({ author, signature, count, at }) => ({ author, signature, count, at }));
          if (others.length) item.aiOthers = others;
          item.aiChecked = true;
        } catch { item.replyUnknown = true; }
      });
      await this.save(project, { refreshedAt: new Date(this.now()).toISOString(), account: result.account,
        waiting: result.waiting.map(finish).sort(order.waiting), progress: result.progress.map(finish).sort(order.progress) });
    } finally { await release(); }
  }

  async save(project, entry) {
    const release = await fileLock(this.file, t('Gerrit reviews are busy in another VS Code window. Try again shortly.'));
    try {
      let projects = {};
      try { projects = JSON.parse(await fs.readFile(this.file, 'utf8'))?.projects || {}; } catch { /* Start a new file. */ }
      projects = Object.fromEntries(Object.entries({ ...projects, [project]: entry })
        .filter(([name, value]) => validProject(name) && iso(value?.refreshedAt))
        .sort(([, a], [, b]) => b.refreshedAt.localeCompare(a.refreshedAt)).slice(0, PROJECT_LIMIT));
      const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ version: 1, projects }), { mode: 0o600 });
        await fs.rename(temporary, this.file);
      } finally { await fs.unlink(temporary).catch(() => {}); }
      await this.load();
    } finally { await release(); }
  }

  // A review just published from this window: the change is in progress now,
  // without waiting for the next refresh.
  async markReviewed(project, number, patchset) {
    const saved = this.projects[project];
    const item = saved && [...saved.waiting, ...saved.progress].find(entry => entry.number === number);
    if (!item || item.ps !== patchset) return;
    const now = new Date(this.now()).toISOString();
    const updated = finish({ ...item, reviewed: true, myPs: patchset, lastMine: now, replyAt: undefined, replyUnknown: false });
    await this.save(project, { ...saved, waiting: saved.waiting.filter(entry => entry.number !== number),
      progress: [...saved.progress.filter(entry => entry.number !== number), updated].sort(order.progress) });
    this.changed();
  }
}

function filters(saved) {
  const result = {};
  for (const [tab, keys] of Object.entries(FILTERS)) {
    const value = saved?.[tab];
    result[tab] = Array.isArray(value) ? [...new Set(value.filter(key => keys.includes(key)))] : [...DEFAULT_FILTERS[tab]];
  }
  return result;
}

module.exports = { GerritQueue, classify, finish, ownerReply, aiReviews, gerritTime, refreshDashboard, readTimeline, latestSnapshot, filters,
  FILTERS, DEFAULT_FILTERS, READY_VOTES, AUTO_REFRESH };
