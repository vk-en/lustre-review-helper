'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lreview-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function repository(t) {
  const directory = await temporary(t);
  // Every commit a second after the one before, as on a real branch: git
  // orders commits of the same second as it was given them, and a fast
  // machine makes several commits within one second.
  let clock = 0;
  const env = args => {
    if (args[0] !== 'commit') return process.env;
    clock = Math.max(Math.floor(Date.now() / 1000), clock + 1);
    return { ...process.env, GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` };
  };
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', env: env(args) }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test Author');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', path.join(directory, 'no-hooks'));
  const commit = async (text, subject) => {
    await fs.writeFile(path.join(directory, 'file.c'), text);
    git('add', 'file.c'); git('commit', '-qm', subject);
    return git('rev-parse', 'HEAD');
  };
  return { directory, git, commit };
}

async function script(directory, name, source) {
  const file = path.join(directory, name);
  await fs.writeFile(file, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  return file;
}

async function until(fn, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for test condition.');
}

module.exports = { temporary, repository, script, until };
