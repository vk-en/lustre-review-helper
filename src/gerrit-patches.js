'use strict';

const { execFile } = require('node:child_process');
const { verifyPatchProjects } = require('./gerrit-project');
const { t } = require('./l10n');

const ORIGIN = 'https://review.whamcloud.com';
const urlError = () => new Error(t('Enter a Gerrit change URL on {origin}.', { origin: ORIGIN }));

function changeUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value)) throw urlError();
  let url;
  try { url = new URL(value.trim()); } catch { throw urlError(); }
  if (url.origin !== ORIGIN || url.username || url.password) throw urlError();
  // Current /c/project/+/number, short /number and legacy /#/c/number links.
  const route = url.pathname === '/' && url.hash.startsWith('#/c/') ? url.hash.slice(1) : url.pathname;
  const match = route.match(/^\/(?:c\/(?:(?:[^/]+\/)+\+\/)?)?([1-9]\d*)(?:\/([1-9]\d*)(?:\/.*)?)?\/?$/);
  const number = Number(match?.[1]), patchset = match?.[2] ? Number(match[2]) : undefined;
  if (!Number.isSafeInteger(number) || number <= 0 || (patchset !== undefined && !Number.isSafeInteger(patchset))) throw urlError();
  return { number, patchset, url: `${ORIGIN}/${number}${patchset ? `/${patchset}` : ''}` };
}

function patchInfo(data, target) {
  if (data?.change_number !== target.number || typeof data.subject !== 'string' || !data.subject.trim() ||
      !Number.isSafeInteger(data.current_patchset) || data.current_patchset < 1) {
    throw new Error(t('Gerrit CLI returned incomplete or unexpected patch details. Update gerrit-cli and try again.'));
  }
  const patchset = target.patchset || data.current_patchset;
  if (patchset !== data.current_patchset && (!Array.isArray(data.patchsets) || !data.patchsets.some(p => p.number === patchset))) {
    throw new Error(t('Patchset {ps} does not exist for change #{number}.', { ps: patchset, number: target.number }));
  }
  return { number: target.number, url: `${ORIGIN}/${target.number}/${patchset}`, patchset,
    subject: data.subject, owner: typeof data.owner === 'string' ? data.owner : '',
    project: typeof data.project === 'string' ? data.project : '', branch: typeof data.branch === 'string' ? data.branch : '',
    revision: patchset === data.current_patchset && /^[a-f0-9]{40,64}$/i.test(data.current_revision || '') ? data.current_revision : undefined };
}

async function readPatch(binary, input, cwd, { signal, timeout = 30000 } = {}) {
  const target = changeUrl(input);
  return new Promise((resolve, reject) => {
    execFile(binary, ['info', `${ORIGIN}/${target.number}`], {
      cwd, signal, timeout, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
      // info uses the configured server even when given a URL. Pin it to the
      // validated host; credentials remain owned and loaded by gerrit-cli.
      env: { ...process.env, GERRIT_URL: ORIGIN, NO_COLOR: '1' },
    }, (error, stdout) => {
      if (error) {
        const message = error.name === 'AbortError' ? t('Reading the Gerrit patch was cancelled.') : error.killed ?
          t('Reading the Gerrit patch timed out. Check your connection or VPN and retry.') :
          ({ 2: t('Gerrit authentication failed. Check the Gerrit CLI account in AI Settings.'),
            3: t('Patch not found or not accessible to your Gerrit account.'),
            4: t('Gerrit CLI could not read this change. Check the URL and CLI version.'),
            5: t('Cannot reach Gerrit. Check your connection or VPN and retry.') })[error.code] ||
          t('Could not read the patch. Check the URL, Gerrit access and CLI installation in AI Settings.');
        reject(new Error(message)); return;
      }
      // Never forward raw process errors or output: they can contain credentials.
      try { resolve(patchInfo(JSON.parse(stdout), target)); }
      catch (e) { reject(new Error(e instanceof SyntaxError ? t('Gerrit CLI returned invalid JSON. Update gerrit-cli and retry.') : e.message)); }
    });
  });
}

class GerritPatches {
  constructor({ find, cwd, changed, read = readPatch }) {
    Object.assign(this, { find, cwd, changed, read });
    this.items = [];
    // This is a preparation queue, not history. Never restore it on activation.
    this.generation = 0;
    this.pending = false; this.message = ''; this.error = false;
    // Changes ticked in Waiting Review or In progress, read in parallel.
    this.adding = new Set();
    this.abort = new AbortController();
  }
  get() { return { items: this.items, pending: this.pending, adding: [...this.adding], message: this.message, error: this.error, addedUrl: this.addedUrl,
    ...(this.errorChange ? { change: this.errorChange } : {}) }; }
  async add(input) {
    if (this.disposed || this.pending) return;
    this.setRepository(this.cwd(), false);
    this.pending = true; this.error = false; this.errorChange = undefined; this.message = t('Reading patch details…'); this.addedUrl = undefined; this.changed();
    const generation = this.generation, signal = this.abort.signal;
    try {
      const target = changeUrl(input);
      if (this.items.some(p => p.number === target.number) || this.adding.has(target.number)) throw new Error(t('Change #{number} is already in the list.', { number: target.number }));
      const cwd = this.cwd();
      if (!cwd) throw new Error(t('Choose a local Git repository in Local commits before adding Gerrit patches.'));
      const binary = await this.find().catch(() => { throw new Error(t('Install gerrit-cli or configure its executable path in AI Settings.')); });
      if (this.disposed || generation !== this.generation) return;
      const item = await this.read(binary, target.url, cwd, { signal });
      if (this.disposed || generation !== this.generation) return;
      await verifyPatchProjects(cwd, [item]);
      if (this.disposed || generation !== this.generation) return;
      if (this.cwd() !== cwd) throw new Error(t('The selected repository changed. Add the Gerrit patch again.'));
      const next = [...this.items, item];
      this.items = next; this.addedUrl = input.trim(); this.message = t('Added change #{number}.', { number: item.number });
    } catch (e) {
      if (generation === this.generation) { this.error = true; this.message = e.message; }
    } finally { if (generation === this.generation) { this.pending = false; if (!this.disposed) this.changed(); } }
  }
  // A change ticked in Waiting Review or In progress: read its current
  // patchset from Gerrit, as for a pasted URL.
  async addChange(number) {
    if (this.disposed || !Number.isSafeInteger(number) || number < 1 || this.adding.has(number) || this.items.some(p => p.number === number)) return;
    this.setRepository(this.cwd(), false);
    const cwd = this.cwd(), generation = this.generation, signal = this.abort.signal;
    this.adding.add(number); this.error = false; this.errorChange = undefined; this.message = ''; this.changed();
    try {
      if (!cwd) throw new Error(t('Choose a local Git repository in Local commits before adding Gerrit patches.'));
      const binary = await this.find().catch(() => { throw new Error(t('Install gerrit-cli or configure its executable path in AI Settings.')); });
      if (this.disposed || generation !== this.generation) return;
      const item = await this.read(binary, `${ORIGIN}/${number}`, cwd, { signal });
      if (this.disposed || generation !== this.generation) return;
      await verifyPatchProjects(cwd, [item]);
      if (this.disposed || generation !== this.generation) return;
      if (this.cwd() !== cwd) throw new Error(t('The selected repository changed. Select the change again.'));
      if (!this.items.some(p => p.number === number)) this.items = [...this.items, item];
    } catch (e) {
      if (generation === this.generation) { this.error = true; this.errorChange = number; this.message = t('Change #{number}: {message}', { number, message: e.message }); }
    } finally { if (generation === this.generation) { this.adding.delete(number); if (!this.disposed) this.changed(); } }
  }
  setRepository(repository, notify = true) {
    if (this.repository === repository) return;
    this.repository = repository;
    this.clear(notify);
  }
  async remove(number) {
    if (this.disposed || this.pending || !this.items.some(p => p.number === number)) return;
    this.pending = true; this.error = false; this.errorChange = undefined; this.message = t('Removing patch…'); this.changed();
    try {
      const next = this.items.filter(p => p.number !== number);
      this.items = next; this.message = '';
    } catch { this.error = true; this.message = t('Could not save the patch list. Try again.'); }
    finally { this.pending = false; if (!this.disposed) this.changed(); }
  }
  clear(notify = true) {
    ++this.generation; this.abort.abort(); this.abort = new AbortController();
    this.items = []; this.adding = new Set(); this.pending = false; this.error = false; this.errorChange = undefined; this.message = ''; this.addedUrl = undefined;
    if (notify && !this.disposed) this.changed();
  }
  dispose() { this.disposed = true; this.abort.abort(); }
}

module.exports = { changeUrl, readPatch, GerritPatches };
