'use strict';

const { resultKey } = require('./review-targets');

// Reports & History keeps only successful reviews of work still open. Given
// what is known about each review, decides which ones to delete and why:
// a review that failed or was cancelled; a Gerrit change that landed or was
// abandoned; a local commit that landed on the base branch, or whose change
// landed or was abandoned. Unknown means keep: changes never vanish from
// Gerrit, so one a search did not return is not a reason to delete.
const DONE = new Set(['clean', 'findings']);
const GERRIT = { MERGED: 'landed', ABANDONED: 'abandoned' };
const LOCAL = { merged: 'landed', abandoned: 'abandoned' };

// runs: finished runs that Review does not show. statuses: Gerrit change
// number -> NEW, MERGED, ABANDONED or MISSING. links: local commit -> its
// Gerrit link state. landed: local commits on the base branch.
function cleanupPlan({ runs, statuses = new Map(), links = new Map(), landed = new Set() }) {
  const plan = new Map();
  const mark = (run, key, reason) => {
    if (!plan.has(run.id)) plan.set(run.id, new Map());
    plan.get(run.id).set(key, reason);
  };
  for (const run of runs) {
    for (const key of run.commits || []) {
      const result = run.results?.find(item => resultKey(item) === key);
      if (!result || !DONE.has(result.status)) { mark(run, key, 'did not finish'); continue; }
      const patch = run.gerritPatches?.find(item => item.id === key);
      if (patch) {
        if (GERRIT[statuses.get(patch.number)]) mark(run, key, GERRIT[statuses.get(patch.number)]);
      } else if (LOCAL[links.get(key)]) mark(run, key, LOCAL[links.get(key)]);
      else if (landed.has(key)) mark(run, key, 'landed');
    }
  }
  return plan;
}

module.exports = { cleanupPlan };
