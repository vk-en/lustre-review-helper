'use strict';

const { git, resolveCommit, listCommits, mergedCommits } = require('./git');

// Finds earlier reviews of local commits for an agent that fixes their
// findings. A commit matches its own review, or the review of an earlier
// version with the same Change-Id: amending or rebasing changes the SHA.
const SHA = /^[a-f0-9]{40,64}$/;
const ACTIVE = new Set(['running', 'cancelling']);
// A Gerrit change: its number, or its review.whamcloud.com URL in any form.
const CHANGE_URL = /^https:\/\/review\.whamcloud\.com\/(?:c\/[^\s?#]+\/\+\/|#\/c\/)?(\d+)(?:[/?#][^\s]*)?$/;
function changeNumber(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const number = Number(/^\d+$/.test(text) ? text : CHANGE_URL.exec(text)?.[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

async function commitInfo(repo, sha) {
  const output = await git(repo, ['log', '-1', '-z', '--format=%s%x01%(trailers:key=Change-Id,valueonly)', sha, '--']).catch(() => '');
  const [subject = '', ids = ''] = output.replace(/\0$/, '').split('\x01');
  const changeId = ids.trim().split('\n')[0].trim();
  return { subject: subject.trim(), changeId: /^I[0-9a-f]{40}$/.test(changeId) ? changeId : undefined };
}

// Without explicit commits: the current branch's commits not yet on its
// remote base branch (the local patch or series), else HEAD alone.
async function localSeries(repo) {
  const commits = await listCommits(repo, 50);
  if (!commits.length) return { commits: [] };
  const { base, merged } = await mergedCommits(repo, commits).catch(() => ({ merged: new Set() }));
  const local = base ? commits.filter(commit => !merged.has(commit.sha)) : [];
  return { base, commits: (local.length ? local : commits.slice(0, 1)).map(commit => commit.sha) };
}

function entry(run, result, match, withFindings) {
  const patch = run.gerritPatches?.find(item => item.id === (result.target || result.sha));
  return { review: run.id, run_status: run.status, status: result.status, match, reviewed_commit: result.sha,
    subject: result.subject || run.subjects?.find(item => item.sha === (result.target || result.sha))?.subject,
    started_at: run.startedAt, finished_at: run.finishedAt, agent: run.agent, model: run.modelName || run.model,
    effort: run.effort || 'default', mode: run.mode, ...(run.since ? { since: run.since } : {}),
    ...(patch ? { gerrit: { change: patch.number, patchset: patch.patchset, project: patch.project } } : {}),
    findings_count: (result.comments || []).length,
    ...(withFindings ? { assessment: result.message || '', findings: (result.comments || []).map(({ file, line, message }) => ({ file, line, message })) } : {}),
    ...(result.error ? { error: result.error } : {}) };
}

async function findReviews(service, { repository, commits, subject, change, limit = 3 } = {}) {
  const repo = service.repository(repository);
  const reviewed = [...service.runs.values()].filter(run => run.repository === repo.id)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .flatMap(run => (run.results || []).filter(result => SHA.test(result.sha || '')).map(result => ({ run, result })));
  // A Gerrit change, also when an agent passes its number or URL as the subject.
  const number = changeNumber(change ?? subject);
  if (change !== undefined && !number) throw new Error('Give a Gerrit change number or its review.whamcloud.com URL.');
  if (number) {
    const found = reviewed.filter(({ run, result }) => run.gerritPatches?.find(patch => patch.id === (result.target || result.sha))?.number === number).slice(0, limit);
    return { repository: repo.id, change: number, reviews: found.map(({ run, result }, index) => entry(run, result, 'change', index === 0)) };
  }
  if (subject) {
    const text = subject.toLowerCase();
    const found = reviewed.filter(({ run, result }) => entry(run, result).subject?.toLowerCase().includes(text)).slice(0, limit);
    return { repository: repo.id, subject, reviews: found.map(({ run, result }, index) => entry(run, result, 'subject', index === 0)) };
  }
  const series = commits?.length ? { commits: await Promise.all(commits.map(ref => resolveCommit(repo.path, ref))) } : await localSeries(repo.path);
  const infos = new Map();
  const info = sha => { if (!infos.has(sha)) infos.set(sha, commitInfo(repo.path, sha)); return infos.get(sha); };
  const results = [];
  for (const sha of series.commits) {
    const own = await info(sha);
    const matches = [];
    for (const { run, result } of reviewed) {
      if (matches.length >= limit) break;
      if (result.sha === sha) { matches.push({ run, result, match: 'same commit' }); continue; }
      if (own.changeId && (await info(result.sha)).changeId === own.changeId) matches.push({ run, result, match: 'earlier version' });
    }
    results.push({ commit: sha, subject: own.subject, ...(own.changeId ? { change_id: own.changeId } : {}),
      reviews: matches.map(({ run, result, match }, index) => entry(run, result, match, index === 0)) });
  }
  return { repository: repo.id, ...(series.base ? { base: series.base } : {}), commits: results };
}

// The review an agent should re-check against: the one chosen in Reports & History.
async function reviewDetails(service, run, report, extra = {}) {
  const result = report.results?.[0];
  if (!result) return { review: run.id, status: report.status, subject: report.subjects?.[0]?.subject, ...(report.error ? { error: report.error } : {}), ...extra };
  const files = SHA.test(result.sha || '') ? await service.reportFiles(run.id, report.reportSha).catch(() => []) : [];
  return { ...entry(run, result, 'selected', true), ...(ACTIVE.has(run.status) ? { note: 'This review is still running.' } : {}),
    report_files: files, ...extra };
}

module.exports = { findReviews, reviewDetails, localSeries, commitInfo, changeNumber };
