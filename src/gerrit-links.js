'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { fileLock } = require('./file-lock');

// The Gerrit change of each local commit, found by its Change-Id, for the
// link icon in Local commits. Results are shared by all windows: a merged
// change never changes again, open and missing ones are checked again later.
const ORIGIN = 'https://review.whamcloud.com';
const CHANGE_ID = /^I[0-9a-f]{40}$/;
const SHA = /^[0-9a-f]{40,64}$/;
const PROJECT = /^[\w.-]+(?:\/[\w.-]+)*$/;
const validProject = name => typeof name === 'string' && name.length <= 200 && PROJECT.test(name) && !name.split('/').some(part => part === '.' || part === '..');
const FRESH = 5 * 60 * 1000;
const LIMIT = 3000;
const STATUSES = ['NEW', 'MERGED', 'ABANDONED'];
// Entries written by this version carry it. An open change saved by an older
// window, without the merge conflict flag, is read again at once.
const FORMAT = 2;

function readChange(binary, id, cwd, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(binary, ['info', id], { cwd, timeout, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GERRIT_URL: ORIGIN, NO_COLOR: '1' } }, (error, stdout) => {
      // Not found and invalid input mean no such change; anything else is unknown.
      // Never forward raw output: it can contain credentials.
      if (error) { reject(Object.assign(new Error('Could not read the Gerrit change.'), { missing: [3, 4].includes(error.code) })); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Gerrit CLI returned invalid change details.')); }
    });
  });
}

function entryFrom(data, changeId, project) {
  const number = Number(data?.change_number), ps = Number(data?.current_patchset);
  if (!Number.isSafeInteger(number) || number < 1 || data.change_id !== changeId || data.project !== project) return undefined;
  return { number, status: STATUSES.includes(data.status) ? data.status : 'NEW', ...(Number.isSafeInteger(ps) && ps > 0 ? { ps } : {}),
    ...(SHA.test(data.current_revision || '') ? { revision: data.current_revision } : {}),
    ...(typeof data.branch === 'string' && data.branch.length <= 200 && !/[\x00-\x1f\x7f]/.test(data.branch) ? { branch: data.branch } : {}),
    // gerrit-cli 0.2.45+: false when the current patchset no longer merges (Merge Conflict).
    ...(typeof data.mergeable === 'boolean' ? { mergeable: data.mergeable } : {}) };
}

function clean(entry) {
  if (!entry || typeof entry !== 'object' || !Number.isFinite(entry.checkedAt)) return undefined;
  const format = entry.format === FORMAT ? { format: FORMAT } : {};
  if (entry.missing === true) return { missing: true, checkedAt: entry.checkedAt, ...format };
  if (!Number.isSafeInteger(entry.number) || entry.number < 1 || !STATUSES.includes(entry.status)) return undefined;
  return { number: entry.number, status: entry.status, ...(Number.isSafeInteger(entry.ps) && entry.ps > 0 ? { ps: entry.ps } : {}),
    ...(SHA.test(entry.revision || '') ? { revision: entry.revision } : {}),
    ...(typeof entry.branch === 'string' && entry.branch.length <= 200 && !/[\x00-\x1f\x7f]/.test(entry.branch) ? { branch: entry.branch } : {}),
    ...(typeof entry.mergeable === 'boolean' ? { mergeable: entry.mergeable } : {}),
    checkedAt: entry.checkedAt, ...format };
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

class GerritLinks {
  constructor({ file, findGerrit, changed = () => {}, read = readChange, now = Date.now }) {
    Object.assign(this, { file, findGerrit, changed, read, now });
    this.entries = new Map();
    this.pending = new Set();
    this.version = undefined;
  }

  key(project, changeId) { return `${project}\n${changeId}`; }

  async load() {
    const stat = await fs.stat(this.file).catch(() => null);
    if (!stat) return;
    let data;
    try { data = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch { return; }
    const entries = new Map();
    for (const [key, value] of Object.entries(data?.changes && typeof data.changes === 'object' ? data.changes : {})) {
      const [project, changeId] = key.split('\n');
      const entry = validProject(project) && CHANGE_ID.test(changeId || '') && clean(value);
      if (entry) entries.set(key, entry);
    }
    // Keep failed lookups of this window: they are not saved.
    for (const [key, entry] of this.entries) if (entry.error && !entries.has(key)) entries.set(key, entry);
    this.entries = entries; this.version = stat.mtimeMs;
  }

  async reload() {
    const stat = await fs.stat(this.file).catch(() => null);
    if (!stat || stat.mtimeMs === this.version) return false;
    await this.load();
    return true;
  }

  // What the link icon of one commit shows.
  view(project, commit) {
    if (!project) return { state: 'none', reason: 'project' };
    if (!commit.changeId) return { state: 'none', reason: 'changeId' };
    const key = this.key(project, commit.changeId), entry = this.entries.get(key);
    if (!entry || entry.error) return { state: this.pending.has(key) ? 'checking' : 'unknown' };
    if (entry.missing) return { state: 'none', reason: 'missing' };
    const state = entry.status === 'MERGED' ? 'merged' : entry.status === 'ABANDONED' ? 'abandoned' :
      entry.revision === commit.sha ? 'current' : 'outdated';
    return { state, number: entry.number, ...(entry.ps ? { ps: entry.ps } : {}), ...(entry.revision ? { revision: entry.revision } : {}),
      ...(entry.branch ? { branch: entry.branch } : {}), ...(entry.status === 'NEW' && entry.mergeable === false ? { conflict: true } : {}) };
  }

  stale(project, commit) {
    if (!commit.changeId) return false;
    const key = this.key(project, commit.changeId), entry = this.entries.get(key);
    if (this.pending.has(key)) return false;
    if (!entry) return true;
    if (entry.status === 'MERGED') return false;
    return this.now() - entry.checkedAt >= FRESH || (entry.status === 'NEW' && entry.format !== FORMAT);
  }

  // Looks up the commits not known yet, or known as open or missing for a while.
  // The branch the work is based on comes first: one Change-Id may be on several branches.
  async check(project, branch, commits, cwd) {
    if (!validProject(project)) return;
    const todo = [...new Map(commits.filter(commit => this.stale(project, commit)).map(commit => [commit.changeId, commit])).values()];
    if (!todo.length) return;
    for (const commit of todo) this.pending.add(this.key(project, commit.changeId));
    this.changed();
    try {
      const binary = await this.findGerrit().catch(() => undefined);
      if (!binary) return;
      await mapLimit(todo, 4, async commit => {
        const key = this.key(project, commit.changeId), checkedAt = this.now();
        let entry;
        try {
          for (const id of [...(branch ? [`${project}~${branch}~${commit.changeId}`] : []), commit.changeId]) {
            try { entry = entryFrom(await this.read(binary, id, cwd), commit.changeId, project); }
            catch (error) { if (!error.missing) throw error; }
            if (entry) break;
          }
          entry = entry ? { ...entry, checkedAt, format: FORMAT } : { missing: true, checkedAt, format: FORMAT };
        } catch { entry = { error: true, checkedAt }; }
        this.entries.set(key, entry);
        this.pending.delete(key);
      });
      await this.save();
    } finally {
      for (const commit of todo) this.pending.delete(this.key(project, commit.changeId));
      this.changed();
    }
  }

  async save() {
    const release = await fileLock(this.file, 'Gerrit links are busy in another VS Code window. Try again shortly.');
    try {
      let saved = {};
      try { saved = JSON.parse(await fs.readFile(this.file, 'utf8'))?.changes || {}; } catch { /* Start a new file. */ }
      const merged = new Map(Object.entries(saved).map(([key, value]) => [key, clean(value)]).filter(([, value]) => value));
      for (const [key, entry] of this.entries) {
        const value = clean(entry), old = merged.get(key);
        if (value && (!old || value.checkedAt >= old.checkedAt)) merged.set(key, value);
      }
      const changes = Object.fromEntries([...merged].sort(([, a], [, b]) => b.checkedAt - a.checkedAt).slice(0, LIMIT));
      const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ version: 1, changes }), { mode: 0o600 });
        await fs.rename(temporary, this.file);
      } finally { await fs.unlink(temporary).catch(() => {}); }
      await this.load();
    } finally { await release(); }
  }
}

const text = (value, max = 200) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max) : '';
// What Reports & History shows about a change: current patchset, CI and
// Code-Review votes, from `gerrit info`.
function changeDetails(data, number) {
  const ps = Number(data?.current_patchset);
  if (Number(data?.change_number) !== number || !Number.isSafeInteger(ps) || ps < 1) return undefined;
  const jenkins = String(data.jenkins_build?.status || '').toUpperCase();
  const build = jenkins === 'SUCCESS' ? 'passed' : /FAIL|ABORT|UNSTABLE/.test(jenkins) ? 'failed' : jenkins ? 'running' : 'none';
  const maloo = Number(data.ci?.maloo_vote);
  const tests = maloo > 0 ? 'passed' : maloo < 0 ? 'failed' : build === 'passed' ? 'running' : 'none';
  const owner = text(data.owner);
  const votes = (Array.isArray(data.reviewers) ? data.reviewers : []).map(reviewer => ({ name: text(reviewer?.name),
    value: Number(String(reviewer?.approvals?.['Code-Review'] ?? '').trim()) }))
    .filter(vote => vote.name && vote.name !== owner && Number.isInteger(vote.value) && vote.value !== 0).slice(0, 20)
    .map(vote => ({ ...vote, value: Math.max(-2, Math.min(2, vote.value)) }));
  return { number, ps, status: STATUSES.includes(data.status) ? data.status : 'NEW', owner, build, tests, votes,
    ...(SHA.test(data.current_revision || '') ? { revision: data.current_revision } : {}),
    ...(typeof data.branch === 'string' && data.branch.length <= 200 ? { branch: text(data.branch) } : {}),
    ...(typeof data.mergeable === 'boolean' ? { mergeable: data.mergeable } : {}) };
}

// The files a newer patchset changed, from `gerrit diff <change> A B`.
function readPatchsetFiles(binary, number, from, to, cwd, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(binary, ['diff', `${ORIGIN}/${number}`, String(from), String(to)], { cwd, timeout, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GERRIT_URL: ORIGIN, NO_COLOR: '1' } }, (error, stdout) => {
      if (error) { reject(new Error('Could not compare the patchsets.')); return; }
      try {
        const data = JSON.parse(stdout);
        if (!Array.isArray(data?.files)) throw new Error();
        resolve([...new Set(data.files.flatMap(file => [file?.path, file?.old_path].filter(item => typeof item === 'string' && item && item.length <= 4096)))]);
      } catch { reject(new Error('Gerrit CLI returned an invalid patchset comparison.')); }
    });
  });
}

// The status of many changes in one `gerrit search`: NEW, MERGED or
// ABANDONED, and MISSING for a change the search did not return, such as a
// private one this account cannot see. Changes do not vanish from Gerrit, so
// MISSING only means unknown.
function searchChanges(binary, numbers, cwd, { timeout = 60000 } = {}) {
  const wanted = [...new Set(numbers)].filter(number => Number.isSafeInteger(number) && number > 0);
  if (!wanted.length) return Promise.resolve(new Map());
  return new Promise((resolve, reject) => {
    execFile(binary, ['search', '--limit', String(wanted.length), wanted.map(number => `change:${number}`).join(' OR ')],
      { cwd, timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GERRIT_URL: ORIGIN, NO_COLOR: '1' } }, (error, stdout) => {
        // Never forward raw output: it can contain credentials.
        if (error) { reject(new Error('Could not search Gerrit.')); return; }
        let data;
        try { data = JSON.parse(stdout); } catch { reject(new Error('Gerrit CLI returned an invalid search result.')); return; }
        if (!Array.isArray(data?.changes)) { reject(new Error('Gerrit CLI returned an invalid search result.')); return; }
        const statuses = new Map(wanted.map(number => [number, 'MISSING']));
        for (const change of data.changes) {
          const number = Number(change?.number);
          if (statuses.has(number)) statuses.set(number, STATUSES.includes(change.status) ? change.status : 'NEW');
        }
        resolve(statuses);
      });
  });
}

module.exports = { GerritLinks, readChange, entryFrom, changeDetails, readPatchsetFiles, searchChanges, FRESH };
