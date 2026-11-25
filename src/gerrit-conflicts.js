'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { t } = require('./l10n');

const execute = promisify(execFile);
const origin = 'https://review.whamcloud.com';
const positive = value => Number.isSafeInteger(value) && value > 0;
const strings = values => Array.isArray(values) ? values.filter(value => typeof value === 'string') : [];
const hasRevision = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value);

// --full names both patchsets and the branch tip. Keep these so an on-demand
// hunk read can never attach new code to the results of an earlier check.
function conflictReport(raw, patch, other) {
  const invalid = () => new Error(t('Unexpected conflict report. Update gerrit-cli and retry.'));
  if (raw?.change !== patch.number || raw.project !== patch.project || !positive(raw.patchset) ||
      !hasRevision(raw.commit) || !hasRevision(raw.tip) || typeof raw.branch !== 'string' ||
      !['ok', 'needs-rebase'].includes(raw.status) || (raw.status === 'ok' && !Array.isArray(raw.conflicts)) ||
      !Number.isSafeInteger(raw.counts?.tried) || !Number.isSafeInteger(raw.counts?.candidates)) throw invalid();
  const rows = [], hunks = [];
  for (const [kind, list] of [['merge', raw.conflicts || []], ['duplicate', raw.silent_only], ['watch', raw.watch]]) {
    if (!Array.isArray(list)) throw invalid();
    for (const pair of list) {
      if (!positive(pair?.cn) || !hasRevision(pair.commit)) throw invalid();
      const notes = (pair.silent || []).map(item => [item.file, item.check, item.what].filter(Boolean).join(' · '));
      for (const item of pair.same_function || []) notes.push([item.file, strings(item.functions).join(', ')].filter(Boolean).join(' · '));
      rows.push({ number: pair.cn, ps: pair.ps, revision: pair.commit, subject: pair.subject || '', kind,
        files: strings(pair.files), notes, first: pair.landing?.target_first, second: pair.landing?.candidate_first });
      if (pair.cn !== other) continue;
      for (const [file, regions] of Object.entries(pair.hunks?.landing || {})) {
        for (const region of regions) {
          if (typeof region.text !== 'string' || !['target_first', 'candidate_first'].includes(region.order)) throw invalid();
          const first = region.order === 'target_first' ? patch.number : other;
          const second = first === other ? patch.number : other;
          hunks.push(`${file}:${region.line} · ${region.kind} · #${first} → #${second}\n${region.text}`);
        }
      }
    }
  }
  return { summary: { number: patch.number, ps: raw.patchset, revision: raw.commit, tip: raw.tip, branch: raw.branch,
    needsRebase: raw.status === 'needs-rebase', files: strings(raw.on_branch?.files),
    ...(raw.on_next?.status === 'conflict' ? { next: { number: raw.on_next.with?.cn, files: strings(raw.on_next.files) } } : {}),
    tried: raw.counts.tried, candidates: raw.counts.candidates, errors: (raw.errors || []).map(item => item.cn).filter(positive), rows },
    hunks: hunks.join('\n\n') };
}

async function readConflicts(binary, patch, repo, { other, signal, timeout = 300000 } = {}) {
  if (!positive(patch.number) || (other !== undefined && !positive(other))) throw new Error('Invalid Gerrit change number.');
  const args = ['conflicts', `${origin}/${patch.number}`, '--repo', repo, '--full'];
  if (other !== undefined) args.push('--hunks-for', String(other));
  let stdout;
  try {
    ({ stdout } = await execute(binary, args, { cwd: repo, signal, timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GERRIT_URL: origin, GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' } }));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(error.killed ? t('Conflict check timed out.') :
      t('Conflict check failed. Check gerrit-cli, Git 2.40 or newer, and access to the project remote.'));
  }
  try { return conflictReport(JSON.parse(stdout), patch, other); }
  catch { throw new Error(t('Unexpected conflict report. Update gerrit-cli and retry.')); }
}

module.exports = { readConflicts };
