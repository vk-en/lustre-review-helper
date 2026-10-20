'use strict';

const { resultKey } = require('./review-targets');

const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const finished = run => !['running', 'cancelling'].includes(run.status);
function subjects(run) {
  return (run.commits || []).map(sha => ({ sha, subject: run.subjects?.find(c => c.sha === sha)?.subject ||
    run.results?.find(c => resultKey(c) === sha)?.subject || sha.slice(0, 12) }));
}
const title = run => subjects(run).map(c => c.subject).join(' / ');

// The service still owns one batch; History and notifications address its patches.
function reports(run) {
  const sharedFailure = run.status === 'failed' && (run.results || []).every(result => ['clean', 'findings'].includes(result.status));
  return subjects(run).map(commit => {
    const result = run.results?.find(r => resultKey(r) === commit.sha);
    const single = run.commits.length === 1;
    const { log, ...metadata } = run;
    return { ...metadata, id: single ? run.id : `${run.id}:${commit.sha}`, runId: run.id, reportSha: commit.sha,
      gerritPatch: run.gerritPatches?.find(patch => patch.id === commit.sha),
      commits: [commit.sha], subjects: [commit], results: result ? [result] : [],
      status: single || sharedFailure || !finished(run) ? run.status : result ? ['clean', 'findings'].includes(result.status) ? 'completed' : result.status : run.status,
      error: single || sharedFailure ? run.error || result?.error : result ? result.error : run.error,
      usage: single ? run.usage : run.usage?.byCommit?.[commit.sha],
      ...(!single ? { durationSeconds: known(result?.duration) ? result.duration : null } : {}) };
  });
}

function findings(results, expected) {
  const complete = results.filter(r => ['clean', 'findings'].includes(r.status));
  if (!complete.length) return null;
  const counts = { total: 0, defect: 0, minor: 0, suggestion: 0, typo: 0, style: 0, nit: 0, other: 0, commitMessage: 0,
    partial: complete.length < expected };
  for (const result of complete) for (const comment of result.comments || []) {
    // Use the protocol's explicit leading category, never infer severity from prose.
    const category = String(comment.message || '').match(/^\s*(?:\*\*)?\((defect|minor|suggestion|typo|style|nit)\)/i)?.[1]?.toLowerCase() || 'other';
    counts.total++; counts[category]++;
    if (['/COMMIT_MSG', 'COMMIT_MSG', 'COMMIT_MESSAGE'].includes(comment.file)) counts.commitMessage++;
  }
  return counts;
}

function summarize(run) {
  const results = run.results || [], usage = run.usage || {}, total = run.commits?.length || 0;
  const reportedTokens = results.filter(r => known(r.tokens)), reportedCosts = results.filter(r => known(r.costUsd));
  const tokens = known(usage.tokens) ? usage.tokens : reportedTokens.length ? reportedTokens.reduce((sum, r) => sum + r.tokens, 0) : null;
  const estimated = known(usage.estimatedCostUsd);
  const cost = estimated ? usage.estimatedCostUsd : known(usage.costUsd) ? usage.costUsd :
    reportedCosts.length ? reportedCosts.reduce((sum, r) => sum + r.costUsd, 0) : null;
  const elapsed = Object.hasOwn(run, 'durationSeconds') ? run.durationSeconds : (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000;
  return { elapsed: known(elapsed) ? elapsed : null, tokens, cost,
    tokenPartial: usage.tokensPartial ?? reportedTokens.length < total,
    costPartial: usage.costPartial ?? reportedCosts.length < total,
    credits: known(usage.credits) ? usage.credits : null,
    costLabel: estimated ? 'API estimate' : run.agent === 'claude' ? 'Est. cost' : 'Cost',
    findings: findings(results, total),
    commits: subjects(run).map(commit => {
      const result = results.find(r => resultKey(r) === commit.sha);
      return { ...commit, status: result?.status || run.status, elapsed: known(result?.duration) ? result.duration : null,
        tokens: known(result?.tokens) ? result.tokens : null, cost: known(result?.costUsd) ? result.costUsd : null,
        findings: findings(result ? [result] : [], 1) };
    }) };
}

module.exports = { finished, subjects, title, findings, summarize, reports };
