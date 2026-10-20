'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

function cliVersion(binary, { timeout = 5000, signal } = {}) {
  return new Promise(resolve => {
    execFile(binary, ['--version'], { timeout, signal, killSignal: 'SIGKILL', maxBuffer: 16384,
      env: { ...process.env, NO_COLOR: '1', AUGMENT_DISABLE_AUTO_UPDATE: '1' } }, (error, stdout) => {
      const version = !error && stdout.trim().match(/^(?:(?:lreview|gerrit(?:-cli)?|gc|codex(?:-cli)?|claude(?: code)?|auggie)(?:,?\s+version)?\s+)?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?:\s+\([^\r\n]*\))?$/i)?.[1];
      resolve(version || undefined);
    });
  });
}

// The extension calls `git rev-parse --end-of-options`, added in Git 2.24;
// review diffs and lreview worktrees need nothing newer.
const GIT_MINIMUM = '2.24';
const GIT_URL = 'https://git-scm.com/downloads';
const atLeast = (version, minimum) => {
  const [a, b] = [version, minimum].map(value => value.split('.').map(Number));
  for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
  return true;
};

function gitVersion({ binary = 'git', timeout = 5000 } = {}) {
  return new Promise(resolve => execFile(binary, ['--version'], { timeout, killSignal: 'SIGKILL', maxBuffer: 16384 },
    (error, stdout) => resolve(!error && String(stdout).trim().match(/^git version (\d+\.\d+(?:\.\d+)?)/)?.[1] || undefined)));
}

// Git runs from PATH, as for every other Git call in the extension and lreview.
async function gitStatus({ version = gitVersion, pathEnv = process.env.PATH } = {}) {
  const found = await version();
  let location;
  for (const directory of (pathEnv || '').split(path.delimiter).filter(Boolean)) {
    try { await fs.access(path.join(directory, 'git'), fs.constants.X_OK); location = path.join(directory, 'git'); break; } catch { /* next */ }
  }
  if (!found) return { status: 'missing', installed: false, minimum: GIT_MINIMUM, path: location };
  const current = atLeast(found, GIT_MINIMUM);
  return { status: current ? 'installed' : 'outdated', installed: current, version: found, minimum: GIT_MINIMUM, path: location };
}

module.exports = { lreviewVersion: cliVersion, cliVersion, gitVersion, gitStatus, GIT_MINIMUM, GIT_URL };
