'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { artifact, artifactPath } = require('./service');
const { gerritTarget, resultKey } = require('./review-targets');
const { t } = require('./l10n');

const ORIGIN = 'https://review.whamcloud.com';
const active = run => ['running', 'cancelling'].includes(run.status);
const draftsOnly = env => !['', 'full'].includes((env.GERRIT_CLI_MODE || '').trim().toLowerCase());

async function postTarget(service, id, key) {
  const run = service.get(id);
  if (active(run) || service.children.has(id)) throw new Error(t('Wait for this review batch to finish.'));
  const patch = run.gerritPatches?.find(p => p.id === key);
  if (!patch || gerritTarget(patch).id !== key) throw new Error(t('Only Gerrit reviews can be published.'));
  const result = run.results?.find(r => resultKey(r) === key);
  if (!['clean', 'findings'].includes(result?.status)) throw new Error(t('This patch has no completed review to publish.'));
  const directory = path.join(service.storage, id, 'artifacts');
  const summary = await artifact(directory, 'summary.json');
  const manifestKey = String(patch.number) + (run.mode === 'light' ? '-light' : '');
  const entry = summary[manifestKey];
  if (!entry || entry.local !== false || ![undefined, 'gerrit'].includes(entry.provider) ||
      entry.base_url !== ORIGIN || entry.number !== patch.number || entry.patchset !== patch.patchset ||
      !/^[a-f0-9]{40,64}$/.test(entry.sha || '') || entry.sha !== result.sha ||
      (patch.revision && entry.sha !== patch.revision) || (entry.repository && entry.repository !== patch.project) ||
      (entry.mode || 'full') !== run.mode || entry.status !== result.status) {
    throw new Error(t('The saved result does not match the reviewed Gerrit patchset. Publication was blocked.'));
  }
  if (entry.status === 'findings') await artifactPath(directory, entry.json);
  return { run, patch, directory, manifestKey, entry };
}

// lreview post owns revision pinning, the manifest lock, no-vote policy and
// duplicate prevention. Never pass --force or omit the selected manifest key.
function post(binary, args, cwd, env) {
  return new Promise((resolve, reject) => execFile(binary, args, {
    cwd, env, timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  }, (error, _stdout, stderr) => {
    // lreview records posted=true in both modes. gerrit-cli reports the
    // completed conversion to private drafts on stderr.
    const drafted = /^\[GERRIT_CLI_MODE=drafts\] created \d+ draft comment\(s\); nothing is published\./m.test(stderr);
    if (!error) return resolve(drafted ? 'drafted' : 'posted');
    const uncertain = !!error.killed || drafted || (draftsOnly(env) && typeof error.code === 'number');
    const safe = new Error(uncertain ? t('Publication status is uncertain. Check the patch in Gerrit before retrying.') :
      t('Could not publish the review. Check Gerrit CLI credentials, access and installation.'));
    safe.uncertain = uncertain;
    reject(safe);
  }));
}

class GerritPublication {
  constructor({ service, find, execute = post, changed = () => {} }) {
    Object.assign(this, { service, find, execute, changed });
    this.states = new Map(); this.pending = new Set();
  }
  identity(id, key) { return `${id}:${key}`; }
  get(id, key) { return this.states.get(this.identity(id, key)) || { status: 'checking', message: t('Checking saved review…') }; }
  async refresh(id, key) {
    const identity = this.identity(id, key);
    if (this.pending.has(identity)) return;
    try {
      const { run, entry, patch } = await postTarget(this.service, id, key);
      const saved = run.publications?.[key];
      const text = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
      const values = { number: patch.number, ps: patch.patchset };
      let state;
      if (saved?.status === 'drafted') {
        state = { status: 'drafted', message: t('Drafts saved on Gerrit #{number}, patchset {ps}. Open Gerrit to publish them.', values) };
      } else if (['unknown', 'drafting'].includes(saved?.status) || (saved?.status === 'publishing' && !entry.posted)) {
        state = { status: 'unknown', message: t('Publication status is uncertain. Check the patch in Gerrit before retrying.') };
      } else if (entry.posted) {
        state = { status: 'posted', message: t('Published to Gerrit #{number}, patchset {ps}.', values),
          postedAt: text(entry.posted_at) || (saved?.status === 'posted' ? text(saved.updatedAt) : undefined) };
      } else if (draftsOnly(process.env)) {
        state = { status: 'ready', draftsOnly: true, message: t('Saves private drafts on Gerrit #{number}, patchset {ps}.', values) };
      } else {
        state = { status: 'ready', message: t('Publishes the assessment and inline comments to #{number}, patchset {ps}. No vote is added.', values) };
      }
      this.states.set(identity, state);
    } catch (error) { this.states.set(identity, { status: 'unavailable', message: error.message }); }
  }
  async publish(id, key) {
    const identity = this.identity(id, key);
    if (this.pending.has(identity)) return;
    this.pending.add(identity);
    const env = { ...process.env, GERRIT_URL: ORIGIN, NO_COLOR: '1' };
    const draftMode = draftsOnly(env);
    this.states.set(identity, { status: 'publishing', draftsOnly: draftMode, message: draftMode ? t('Saving drafts…') : t('Publishing to Gerrit…') }); this.changed();
    let started = false;
    let outcome;
    const save = async status => {
      const run = this.service.runs.get(id);
      run.publications ||= {}; run.publications[key] = { status, updatedAt: new Date().toISOString() };
      await this.service.persist(run);
    };
    try {
      const target = await postTarget(this.service, id, key);
      const saved = target.run.publications?.[key]?.status;
      if (target.entry.posted || saved === 'drafted') return;
      if (['publishing', 'drafting', 'unknown'].includes(saved)) {
        const error = new Error(t('Publication status is uncertain. Check the patch in Gerrit before retrying.'));
        error.uncertain = true; throw error;
      }
      const binary = await this.find();
      // Capture the same signature used in the human-readable report, including
      // for reports produced before signatures were introduced.
      await this.service.reportFiles(id, key);
      const signature = this.service.get(id).signature;
      if (!signature) throw new Error(t('The report signature is unavailable. Reopen the report and retry.'));
      await save(draftMode ? 'drafting' : 'publishing'); started = true;
      outcome = await this.execute(binary, ['post', target.manifestKey, '--results-dir', target.directory, '--prefix', signature], target.run.repo, env);
      const confirmed = await postTarget(this.service, id, key);
      if (!confirmed.entry.posted || (draftMode && outcome !== 'drafted')) {
        const error = new Error(t('Publication was not confirmed. Check the patch in Gerrit before retrying.'));
        error.uncertain = true; throw error;
      }
      await save(outcome === 'drafted' ? 'drafted' : 'posted');
    } catch (error) {
      if (started && outcome === 'drafted') error.uncertain = true;
      if (started) await save(error.uncertain ? 'unknown' : 'error');
      this.states.set(identity, { status: error.uncertain ? 'unknown' : 'error', draftsOnly: draftMode, message: error.message });
      throw error;
    } finally {
      this.pending.delete(identity);
      if (this.get(id, key).status === 'publishing') await this.refresh(id, key);
      this.changed();
    }
  }
}

module.exports = { GerritPublication, postTarget };
