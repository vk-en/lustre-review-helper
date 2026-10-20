'use strict';

const { execFile } = require('node:child_process');

// Unresolved Gerrit discussions shown in the review diff only. They are read
// when the diff opens and never reach a review, its prompts or its results.
const ORIGIN = 'https://review.whamcloud.com';
const text = value => typeof value === 'string' ? value : '';
// Our own published findings carry the signature before the finding, in bold
// as gerrit-cli writes it today, or plain.
const unsigned = message => text(message).replace(/^\s*(?:\*\*)?\\?\[[^\]\n]*\\?\](?:\*\*)?\s*/, '').trim();
const fileOf = path => ['/COMMIT_MSG', 'COMMIT_MSG'].includes(path) ? '/COMMIT_MSG' : path;

function readComments(binary, number, cwd, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(binary, ['comments', `${ORIGIN}/${number}`, '--no-context'], {
      cwd, timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GERRIT_URL: ORIGIN, NO_COLOR: '1' },
    }, (error, stdout) => {
      // Never forward raw process output: it can contain credentials.
      if (error) { reject(new Error(error.killed ? 'Reading Gerrit comments timed out.' : 'Could not read Gerrit comments. Check gerrit-cli in AI Settings.')); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Gerrit CLI returned invalid comments. Update gerrit-cli and retry.')); }
    });
  });
}

// Unresolved threads started on the reviewed patchset, minus copies of our
// own findings. Threads from earlier patchsets are left out: their lines may
// have moved, and owners do not always resolve them after a fix.
function forPatchset(data, patchset, findings = []) {
  const ours = new Set(findings.map(finding => `${fileOf(finding.file)}\n${finding.line}\n${unsigned(finding.message)}`));
  return (Array.isArray(data?.threads) ? data.threads : []).flatMap(thread => {
    const root = thread?.root_comment, replies = Array.isArray(thread?.replies) ? thread.replies : [];
    if (!root || root.patch_set !== patchset || typeof root.file_path !== 'string' || !root.file_path) return [];
    const last = replies.length ? replies.at(-1) : root;
    if (thread.is_resolved === true || last.unresolved === false) return [];
    const file = fileOf(root.file_path), line = Number.isInteger(root.line) && root.line > 0 ? root.line : 1;
    if (ours.has(`${file}\n${line}\n${unsigned(root.message)}`)) return [];
    return [{ file, line, patchsetLevel: file === '/PATCHSET_LEVEL',
      comments: [root, ...replies].map(comment => ({ author: text(comment.author?.name) || text(comment.author?.username) || 'Gerrit user',
        message: text(comment.message), updated: text(comment.updated) })) }];
  });
}

module.exports = { readComments, forPatchset };
