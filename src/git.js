'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

async function git(repo, args) {
  const { stdout } = await run('git', ['--no-pager', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
}

async function repositoryRoot(directory) {
  return (await git(directory, ['rev-parse', '--show-toplevel'])).trim();
}

async function currentBranch(repo) {
  try { return (await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim(); }
  catch (error) { if (error.code !== 1) throw error; }
  return `Detached HEAD · ${(await git(repo, ['rev-parse', '--short', 'HEAD'])).trim()}`;
}

async function resolveCommit(repo, ref) {
  if (typeof ref !== 'string' || !ref || ref.length > 256 || /[\x00-\x1f]/.test(ref) || ref.startsWith('-')) {
    throw new Error('Provide a commit SHA or a local Git reference such as HEAD.');
  }
  // Never pass git's own message on: an agent needs to know which ref is wrong.
  try { return (await git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim(); }
  catch { throw new Error(`Unknown commit: ${ref}. Use a commit SHA, a branch or another local Git reference.`); }
}

async function listCommits(repo, limit = 30) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Commit limit must be 1–200.');
  try { await resolveCommit(repo, 'HEAD'); } catch (error) {
    // Empty repositories have no HEAD, but a broken/non-repository path is an error.
    await repositoryRoot(repo);
    if (!(await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim()) return [];
    throw error;
  }
  // The Change-Id trailer finds a commit's change on Gerrit.
  const fields = (await git(repo, ['log', `-${limit}`, '-z',
    '--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%(trailers:key=Change-Id,valueonly)', 'HEAD', '--'])).split('\0');
  const commits = [];
  for (let i = 0; i + 5 < fields.length; i += 6) {
    const [sha, shortSha, author, date, subject, trailers] = fields.slice(i, i + 6);
    const changeId = trailers.split('\n').map(value => value.trim()).find(value => /^I[0-9a-f]{40}$/.test(value));
    commits.push({ sha, shortSha, author, date, subject, ...(changeId ? { changeId } : {}) });
  }
  return commits;
}

function safeGitPath(file) {
  return typeof file === 'string' && file.length > 0 && !file.startsWith('/') &&
    !file.includes('\\') && !/[\x00-\x1f]/.test(file) && !file.split('/').includes('..');
}

async function readFileAtCommit(repo, sha, file) {
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('Invalid commit SHA.');
  if (file === '/COMMIT_MSG') return git(repo, ['show', '-s', '--format=%B', sha]);
  if (!safeGitPath(file)) throw new Error('Invalid file path in review.');
  return git(repo, ['show', `${sha}:${file}`]);
}

// The remote branch this work is based on: the configured upstream, or else
// the remote-tracking branch with the fewest commits of HEAD missing from it.
// Topic branches made for Gerrit often have no upstream at all.
async function branchBase(repo) {
  try {
    const upstream = (await git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim();
    if (upstream) return upstream;
  } catch { /* No upstream configured, or a detached HEAD. */ }
  const refs = (await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])).split('\n')
    .map(ref => ref.trim()).filter(ref => ref && !ref.endsWith('/HEAD') && !ref.startsWith('-')).slice(0, 300);
  const LIMIT = 2000;
  const counts = [];
  for (let index = 0; index < refs.length; index += 8) {
    counts.push(...await Promise.all(refs.slice(index, index + 8).map(async ref => ({ ref,
      ahead: Number((await git(repo, ['rev-list', '--count', `--max-count=${LIMIT}`, 'HEAD', '--not', ref, '--']).catch(() => String(LIMIT))).trim()) }))));
  }
  const best = counts.sort((a, b) => a.ahead - b.ahead || Number(b.ref.startsWith('origin/')) - Number(a.ref.startsWith('origin/')) || a.ref.localeCompare(b.ref))[0];
  return best && best.ahead < LIMIT ? best.ref : undefined;
}

const changeIds = output => output.split('\0').map(record => record.trim()).filter(Boolean);

// Commits of the list that already landed on the base branch: reachable from
// it, or carrying a Change-Id that landed there, since Gerrit may cherry-pick
// or rebase a change on submit. Compares with what the last fetch brought.
async function mergedCommits(repo, commits) {
  if (!commits.length) return { base: undefined, merged: new Set() };
  const base = await branchBase(repo).catch(() => undefined);
  if (!base) return { base: undefined, merged: new Set() };
  const pending = new Set((await git(repo, ['rev-list', `--max-count=${commits.length}`, 'HEAD', '--not', base, '--'])).split('\n').filter(Boolean));
  const merged = new Set(commits.filter(commit => !pending.has(commit.sha)).map(commit => commit.sha));
  const local = commits.filter(commit => pending.has(commit.sha));
  if (!local.length) return { base, merged };
  const ids = new Map();
  for (const record of changeIds(await git(repo, ['log', '-z', '--no-walk=unsorted', '--format=%H%x01%(trailers:key=Change-Id,valueonly)', ...local.map(commit => commit.sha), '--']))) {
    const [sha, value = ''] = record.split('\x01');
    const id = value.trim().split('\n')[0].trim();
    if (/^I[0-9a-f]{40}$/.test(id)) ids.set(sha.trim(), id);
  }
  if (!ids.size) return { base, merged };
  const fork = (await git(repo, ['merge-base', 'HEAD', base]).catch(() => '')).trim();
  const landed = new Set(changeIds(await git(repo, ['log', '-z', '--max-count=5000', '--format=%(trailers:key=Change-Id,valueonly)', fork ? `${fork}..${base}` : base, '--']))
    .flatMap(record => record.split('\n').map(id => id.trim())).filter(Boolean));
  for (const [sha, id] of ids) if (landed.has(id)) merged.add(sha);
  return { base, merged };
}

// The remote branch a commit was based on: the point where it joins the
// branches of the given remote, and the closest branch that holds it. Works
// for any commit, also one no longer on a branch (an amended version).
// A commit those branches already hold has landed.
async function commitBase(repo, sha, remote) {
  const lines = (await git(repo, ['rev-list', '--boundary', '--max-count=2000', sha, '--not', `--remotes=${remote}`, '--'])).split('\n').filter(Boolean);
  if (!lines.length) return { landed: true };
  const fork = lines.find(line => line.startsWith('-'))?.slice(1);
  if (!fork) return {};
  const refs = (await git(repo, ['for-each-ref', '--format=%(refname:short)', '--contains', fork, `refs/remotes/${remote}/`])).split('\n')
    .map(ref => ref.trim()).filter(ref => ref && !ref.endsWith('/HEAD')).slice(0, 50);
  if (!refs.length) return {};
  const distance = await Promise.all(refs.map(async ref => ({ ref, count: Number((await git(repo, ['rev-list', '--count', `${fork}..${ref}`, '--'])).trim()) })));
  return { base: distance.sort((a, b) => a.count - b.count || a.ref.localeCompare(b.ref))[0].ref };
}

// Reviewed commits whose work landed: the commit itself is on a branch of the
// Gerrit remote, or its Change-Id is on the branch it was based on, after a
// rebase or cherry-pick on submit. Each commit is checked against its own
// base, so a backport is not taken for the change it was ported from, and an
// amended version that is simply off the current branch has not landed.
// Returns the landed commits and the base of each commit that has one.
async function landedCommits(repo, commits) {
  const landed = new Set(), bases = new Map();
  if (!commits.length) return { landed, bases };
  const current = await branchBase(repo).catch(() => undefined);
  if (!current) return { landed, bases };
  const remote = current.includes('/') ? current.slice(0, current.indexOf('/')) : current;
  const ids = new Map();
  for (const commit of commits) {
    const found = await commitBase(repo, commit.sha, remote).catch(() => ({}));
    if (found.landed) { landed.add(commit.sha); continue; }
    if (!found.base) continue;
    bases.set(commit.sha, found.base);
    if (!commit.changeId) continue;
    if (!ids.has(found.base)) {
      ids.set(found.base, new Set(changeIds(await git(repo, ['log', '-z', '--max-count=5000', '--format=%(trailers:key=Change-Id,valueonly)', found.base, '--']).catch(() => ''))
        .flatMap(record => record.split('\n').map(id => id.trim())).filter(Boolean)));
    }
    if (ids.get(found.base).has(commit.changeId)) landed.add(commit.sha);
  }
  return { landed, bases };
}

module.exports = { git, repositoryRoot, currentBranch, resolveCommit, listCommits, safeGitPath, readFileAtCommit, branchBase, mergedCommits, landedCommits, commitBase };
