'use strict';

const { changeUrl } = require('./gerrit-patches');
const SHA = /^[a-f0-9]{40,64}$/;
const resultKey = result => result.target || result.sha;

function gerritTarget(patch) {
  const parsed = changeUrl(patch?.url);
  if (!parsed.patchset || patch.number !== parsed.number || patch.patchset !== parsed.patchset ||
      typeof patch.project !== 'string' || !/^[\w.-]+(?:\/[\w.-]+)*$/.test(patch.project) ||
      patch.project.split('/').some(part => part === '.' || part === '..')) {
    throw new Error(require('./l10n').t('Gerrit patch details are incomplete. Remove the patch and add its URL again.'));
  }
  return { id: `gerrit:${parsed.number}:${parsed.patchset}`, number: parsed.number, patchset: parsed.patchset,
    project: patch.project, subject: typeof patch.subject === 'string' ? patch.subject : `Gerrit #${parsed.number}`,
    revision: SHA.test(patch.revision || '') ? patch.revision : undefined,
    // Kept from the patch list for Reports & History; Gerrit reports the owner by name.
    owner: typeof patch.owner === 'string' && patch.owner.trim() ? patch.owner.trim().slice(0, 200) : undefined,
    branch: typeof patch.branch === 'string' && patch.branch.trim() && !/[\x00-\x1f\x7f]/.test(patch.branch) ? patch.branch.trim().slice(0, 200) : undefined,
    // lreview recognizes an explicit patchset only in the /+/<change>/<ps> form.
    url: `https://review.whamcloud.com/c/${patch.project}/+/${parsed.number}/${parsed.patchset}` };
}

function summaryEntry(summary, key, patches = []) {
  const patch = patches.find(p => p.id === key);
  return Object.values(summary).find(entry => entry && (patch ?
    entry.local === false && entry.number === patch.number && entry.patchset === patch.patchset && SHA.test(entry.sha || '') &&
      (!patch.revision || entry.sha === patch.revision) && (!entry.repository || entry.repository === patch.project) :
    entry.local === true && entry.sha === key));
}

module.exports = { gerritTarget, summaryEntry, resultKey };
