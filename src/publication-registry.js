'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileLock } = require('./file-lock');

// Every window of this VS Code profile shares one record of the reviews it
// published to Gerrit. Entries are keyed by Gerrit project, change and
// patchset, never by folder: two clones of one project see the same record.
// Finished reviews not yet published are recorded too, with the folder of the
// window that holds them, until they are published or their history is cleared.
const LIMIT = 5000;
const READY_LIMIT = 2000;
const SHA = /^[a-f0-9]{40,64}$/;
const RUN = /^[a-f0-9-]{36}$/;
const PROJECT = /^[\w.-]+(?:\/[\w.-]+)*$/;
const text = (value, max = 500) => typeof value === 'string' && value.trim() && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value) ? value.trim().slice(0, max) : undefined;
const identity = entry => `${entry.project}#${entry.change}#${entry.patchset}`;
const readyIdentity = entry => `${entry.run}#${identity(entry)}`;

function clean(entry) {
  if (!entry || typeof entry !== 'object') return undefined;
  const project = text(entry.project, 200), postedAt = Date.parse(entry.postedAt);
  if (!project || !PROJECT.test(project) || project.split('/').some(part => part === '.' || part === '..') ||
      !Number.isSafeInteger(entry.change) || entry.change < 1 || !Number.isSafeInteger(entry.patchset) || entry.patchset < 1 ||
      !Number.isFinite(postedAt)) return undefined;
  const optional = { subject: text(entry.subject), owner: text(entry.owner, 200), branch: text(entry.branch, 200), signature: text(entry.signature, 200) };
  return { project, change: entry.change, patchset: entry.patchset,
    ...(SHA.test(entry.revision || '') ? { revision: entry.revision } : {}),
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
    ...(RUN.test(entry.run || '') ? { run: entry.run } : {}),
    postedAt: new Date(postedAt).toISOString() };
}

// One entry per change and patchset; the latest publication of a patchset wins.
function merge(entries, additions) {
  const merged = new Map(entries.map(entry => [identity(entry), entry]));
  for (const entry of additions.map(clean).filter(Boolean)) {
    const existing = merged.get(identity(entry));
    if (!existing || entry.postedAt >= existing.postedAt) merged.set(identity(entry), entry);
  }
  return [...merged.values()].sort((a, b) => b.postedAt.localeCompare(a.postedAt) || identity(a).localeCompare(identity(b))).slice(0, LIMIT);
}

function cleanReady(entry) {
  const base = clean({ ...entry, postedAt: entry?.completedAt });
  if (!base?.run) return undefined;
  const { postedAt, revision, owner, branch, signature, ...rest } = base;
  const folder = typeof entry.folder === 'string' && path.isAbsolute(entry.folder) && entry.folder.length <= 4096 &&
    !/[\x00-\x1f\x7f]/.test(entry.folder) ? entry.folder : undefined;
  return { ...rest, ...(folder ? { folder } : {}), completedAt: postedAt };
}

// Unpublished reviews of patchsets nobody has published yet, newest first.
function mergeReady(entries, additions, publications, forget = []) {
  const gone = new Set(forget), posted = new Set(publications.map(identity));
  const merged = new Map(entries.filter(entry => !gone.has(entry.run)).map(entry => [readyIdentity(entry), entry]));
  for (const entry of additions.map(cleanReady).filter(Boolean)) if (!gone.has(entry.run)) merged.set(readyIdentity(entry), entry);
  return [...merged.values()].filter(entry => !posted.has(identity(entry)))
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt) || readyIdentity(a).localeCompare(readyIdentity(b))).slice(0, READY_LIMIT);
}

// The Gerrit patches a run published: those whose publication was confirmed.
function fromRun(run) {
  if (!run || !Array.isArray(run.gerritPatches)) return [];
  return run.gerritPatches.flatMap(patch => {
    const saved = run.publications?.[patch.id];
    if (saved?.status !== 'posted') return [];
    const result = run.results?.find(entry => (entry.target || entry.sha) === patch.id);
    return [{ project: patch.project, change: patch.number, patchset: patch.patchset, revision: patch.revision || result?.sha,
      subject: patch.subject, owner: patch.owner, branch: patch.branch, signature: run.signature, run: run.id, postedAt: saved.updatedAt }];
  });
}

// Patches a finished run reviewed without publishing them yet.
function readyFromRun(run) {
  if (!run || !Array.isArray(run.gerritPatches) || ['running', 'cancelling'].includes(run.status)) return [];
  return run.gerritPatches.flatMap(patch => {
    if (run.publications?.[patch.id]?.status === 'posted') return [];
    const result = run.results?.find(entry => (entry.target || entry.sha) === patch.id);
    if (!['clean', 'findings'].includes(result?.status)) return [];
    return [{ project: patch.project, change: patch.number, patchset: patch.patchset, subject: patch.subject,
      run: run.id, folder: run.repo, completedAt: run.finishedAt || run.startedAt }];
  });
}

function parse(data) {
  const publications = merge([], Array.isArray(data?.publications) ? data.publications.map(clean).filter(Boolean) : []);
  const reviews = mergeReady([], Array.isArray(data?.reviews) ? data.reviews : [], publications);
  return { publications, reviews };
}

class PublicationRegistry {
  constructor({ file, workspaceStorage, extensionId }) {
    Object.assign(this, { file, workspaceStorage, extensionId });
    this.entries = [];
    this.reviews = [];
    this.queue = Promise.resolve();
    this.version = undefined;
  }

  // The runs every workspace saved: publications made before this registry
  // existed, and finished reviews waiting to be published.
  async archive() {
    if (!this.workspaceStorage || !this.extensionId) return [];
    const found = [];
    for (const workspace of await fs.readdir(this.workspaceStorage, { withFileTypes: true }).catch(() => [])) {
      if (!workspace.isDirectory() || !/^[a-f0-9]{32}$/.test(workspace.name)) continue;
      const directory = path.join(this.workspaceStorage, workspace.name, this.extensionId, 'runs');
      for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || !RUN.test(entry.name)) continue;
        try {
          const file = path.join(directory, entry.name, 'run.json');
          const stat = await fs.lstat(file);
          if (!stat.isFile() || stat.size > 16 * 1024 * 1024) continue;
          const { log, ...run } = JSON.parse(await fs.readFile(file, 'utf8'));
          if (run.id === entry.name) found.push(run);
        } catch { /* One unreadable run must not hide the others. */ }
      }
    }
    return found;
  }

  // Unpublished reviews are rebuilt from the runs on disk, so a deleted run
  // or one published outside this registry does not linger.
  async initialize(runs = []) {
    const archived = await this.archive(), current = [...runs];
    await this.transaction({ publications: [...archived, ...current].flatMap(fromRun),
      ready: [...archived, ...current].flatMap(readyFromRun), replaceReady: true });
  }

  record(run) { return this.transaction({ publications: fromRun(run), ready: readyFromRun(run) }); }

  // Reviews whose history was cleared in this window.
  forget(runs) { return this.transaction({ forget: [...runs] }); }

  transaction(changes = []) {
    const { publications: additions = [], ready = [], forget = [], replaceReady = false } = Array.isArray(changes) ? { publications: changes } : changes;
    const operation = this.queue.catch(() => {}).then(async () => {
      const release = await fileLock(this.file, 'Published reviews are busy in another VS Code window. Try again shortly.');
      try {
        let saved = { publications: [], reviews: [] };
        try { saved = parse(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        const merged = merge(saved.publications, additions);
        const reviews = mergeReady(replaceReady ? [] : saved.reviews, ready, merged, forget);
        if (JSON.stringify([merged, reviews]) !== JSON.stringify([saved.publications, saved.reviews]) || !(await fs.stat(this.file).catch(() => null))) {
          const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
          try {
            await fs.writeFile(temporary, JSON.stringify({ version: 1, publications: merged, reviews }), { mode: 0o600 });
            await fs.rename(temporary, this.file);
          } finally { await fs.unlink(temporary).catch(() => {}); }
        }
        this.entries = merged; this.reviews = reviews;
        this.version = (await fs.stat(this.file).catch(() => null))?.mtimeMs;
      } finally { await release(); }
    });
    this.queue = operation;
    return operation;
  }

  // Picks up publications from other windows. Writes replace the file by
  // rename, so a read without the lock always sees a whole file.
  async refresh() {
    const stat = await fs.stat(this.file).catch(() => null);
    if (!stat || stat.mtimeMs === this.version) return false;
    try { ({ publications: this.entries, reviews: this.reviews } = parse(JSON.parse(await fs.readFile(this.file, 'utf8')))); }
    catch { return false; }
    this.version = stat.mtimeMs;
    return true;
  }

  find(project, change, patchset) {
    return this.entries.find(entry => entry.project === project && entry.change === change && entry.patchset === patchset);
  }

  forProject(project) { return this.entries.filter(entry => entry.project === project); }

  // Finished, unpublished reviews of one patchset, from any window.
  ready(project, change, patchset) {
    return this.reviews.filter(entry => entry.project === project && entry.change === change && entry.patchset === patchset);
  }
}

module.exports = { PublicationRegistry, fromRun, readyFromRun, merge, mergeReady, clean };
