'use strict';

// Prepares a release in the extension's own repository:
//
//   node scripts/release.js patch|minor|major|X.Y.Z [--dry-run]
//
// On a clean main it runs the tests, sets the version in package.json (also
// the title of the version button), package-lock.json and the README's badge,
// turns `## Unreleased` at the top of CHANGELOG.md into the
// version's heading, builds dist/<name>-<version>.vsix, then commits
// (Signed-off-by, signed as git config says) and tags vX.Y.Z. It never pushes:
// pushing the tag starts the Release workflow. --dry-run checks and builds
// without changing anything. The current version, while it has no tag, is
// released as it stands: tested, built and tagged, as for the first release.
//
//   node scripts/release.js --notes X.Y.Z
//
// prints that version's CHANGELOG section, for the GitHub release.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = name => path.join(root, name);
const VERSION = /^\d+\.\d+\.\d+$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}
function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error) fail(`git: ${result.error.message}`);
  return { ok: result.status === 0, out: (result.stdout || '').trim(), err: (result.stderr || '').trim() };
}
function node(script, ...args) {
  const result = spawnSync(process.execPath, [file(script), ...args], { cwd: root, stdio: 'inherit' });
  return result.status === 0 && !result.signal;
}

// The changelog's sections by heading: '## 0.1.0' or '## Unreleased'.
function sections(text) {
  const found = [];
  for (const match of text.matchAll(/^## +(.+?)[ \t]*$/gm)) found.push({ title: match[1], start: match.index, body: match.index + match[0].length });
  return found.map((section, i) => ({ ...section, end: found[i + 1]?.start ?? text.length,
    notes: text.slice(section.body, found[i + 1]?.start ?? text.length).trim() }));
}

const args = process.argv.slice(2);
const changelog = fs.readFileSync(file('CHANGELOG.md'), 'utf8');

if (args[0] === '--notes') {
  const section = sections(changelog).find(entry => entry.title === args[1]);
  if (!section?.notes) fail(`CHANGELOG.md has no notes for ${args[1] || 'that version'}.`);
  console.log(section.notes);
  process.exit(0);
}

const dryRun = args.includes('--dry-run'), target = args.find(arg => !arg.startsWith('--'));
if (!target) fail('Usage: node scripts/release.js patch|minor|major|X.Y.Z [--dry-run]');
const pkg = JSON.parse(fs.readFileSync(file('package.json'), 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);
const version = { patch: `${major}.${minor}.${patch + 1}`, minor: `${major}.${minor + 1}.0`, major: `${major + 1}.0.0` }[target] || target;
if (!VERSION.test(version)) fail(`Not a version: ${target}`);
const current = version === pkg.version;
const newer = version.split('.').map(Number).reduce((order, part, i) => order || part - [major, minor, patch][i], 0) > 0;
if (!newer && !current) fail(`${version} is not newer than ${pkg.version}.`);

// Only in the extension's own repository, on a clean main.
const top = git('rev-parse', '--show-toplevel');
if (!top.ok || fs.realpathSync(top.out) !== fs.realpathSync(root)) fail(`Run this in the extension's own repository; ${root} is not the root of one.`);
const branch = git('branch', '--show-current').out;
if (branch !== 'main') fail(`Release from main, not ${branch || 'a detached HEAD'}.`);
if (git('status', '--porcelain').out) fail('Commit or stash your changes first.');
if (git('rev-parse', '-q', '--verify', `refs/tags/v${version}`).ok) fail(`Tag v${version} already exists.`);

// The notes: under '## Unreleased', or already under the version.
const first = sections(changelog)[0];
if (!first || ![version, ...(current ? [] : ['Unreleased'])].includes(first.title) || !first.notes) {
  fail(current ? `CHANGELOG.md must start with the notes of ${version}.` : `Put the notes of this release at the top of CHANGELOG.md, under '## Unreleased'.`);
}

console.log(`${dryRun ? 'Checking' : 'Releasing'} ${pkg.name} ${current ? version : `${pkg.version} → ${version}`}`);
if (!node('scripts/test.js')) fail('The tests failed; nothing was changed.');
if (dryRun) {
  if (!node('scripts/build.js', '--out', 'dist/dry-run')) fail('The build failed.');
  console.log(`Dry run: the tests pass and it builds. A release would ${current ? '' : `set ${version}, head CHANGELOG.md with '## ${version}', commit and `}tag v${version}.`);
  process.exit(0);
}

if (current) {
  if (!node('scripts/build.js')) fail('The build failed.');
} else release();

// Signed like the maintainer's other commits when git is set up to sign.
const sign = ['tag.gpgSign', 'commit.gpgSign'].some(key => git('config', '--type=bool', '--get', key).out === 'true');
const tag = git('tag', sign ? '-s' : '-a', `v${version}`, '-m', `${pkg.displayName || pkg.name} ${version}`);
if (!tag.ok) fail(`git tag failed:\n${tag.err}`);
console.log(`${current ? 'Tagged' : 'Committed and tagged'} v${version}. To publish: git push origin main v${version}`);

// A newer version: written everywhere it shows, built, and committed.
function release() {
  const changed = ['package.json', 'package-lock.json', 'CHANGELOG.md', 'README.md'];
  fs.writeFileSync(file('package.json'), fs.readFileSync(file('package.json'), 'utf8').replace(/("version":\s*")[^"]+(")/, `$1${version}$2`)
    .replace(`"title": "v${pkg.version}"`, `"title": "v${version}"`));
  fs.writeFileSync(file('README.md'), fs.readFileSync(file('README.md'), 'utf8').replaceAll(`Version ${pkg.version}`, `Version ${version}`)
    .replaceAll(`badge/version-${pkg.version}-`, `badge/version-${version}-`));
  const lock = JSON.parse(fs.readFileSync(file('package-lock.json'), 'utf8'));
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  fs.writeFileSync(file('package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  fs.writeFileSync(file('CHANGELOG.md'), `${changelog.slice(0, first.start)}## ${version}${changelog.slice(first.body)}`);
  if (!node('scripts/build.js')) {
    git('checkout', '--', ...changed);
    fail('The build failed; the version change was undone.');
  }

  git('add', '--', ...changed);
  const commit = git('commit', '-s', '-m', `Release ${version}`);
  if (!commit.ok) fail(`git commit failed:\n${commit.err}`);
}
