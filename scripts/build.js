'use strict';

// Builds the .vsix into dist/ (or --out <folder>) after checking that it will
// work: every script parses, and the package holds everything the extension
// loads and nothing of the development files. Needs `npm ci` for vsce.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const vsce = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
const outIndex = process.argv.indexOf('--out');
const out = path.resolve(root, outIndex > 0 && process.argv[outIndex + 1] ? process.argv[outIndex + 1] : 'dist');
const vsix = path.join(out, `${pkg.name}-${pkg.version}.vsix`);

// All the package may hold: anything else (tests, docs, tools, a stray
// folder) is a mistake in .vscodeignore.
const ALLOWED = [/^(src|media|l10n)\//, /^package(\.nls(\.[\w-]+)?)?\.json$/, /^(README|CHANGELOG)\.md$/, /^LICENSE(\.txt)?$/];
const JUNK = /(^|\/)\.DS_Store$/;

const problems = [];
const list = (folder, extension) => fs.readdirSync(path.join(root, folder)).filter(name => name.endsWith(extension)).map(name => `${folder}/${name}`);
function run(args, options = {}) {
  const result = spawnSync(process.execPath, [vsce, ...args], { cwd: root, encoding: 'utf8', ...options });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || '');
    throw new Error(`vsce ${args[0]} failed.`);
  }
  return result.stdout;
}

// Every script parses: the panel's scripts run only in the webview, which no
// test loads as a whole.
for (const file of [...list('src', '.js'), ...list('media', '.js')]) {
  const check = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (check.status !== 0) problems.push(`${file} does not parse:\n${check.stderr.trim()}`);
}

// The version is also written where VS Code and the Marketplace show it.
const shown = pkg.contributes?.commands?.find(entry => entry.command === 'lustreReview.version')?.title;
if (shown !== `v${pkg.version}`) problems.push(`package.json: the title of lustreReview.version is ${shown}, not v${pkg.version}.`);
if (!fs.readFileSync(path.join(root, 'README.md'), 'utf8').includes(`badge/version-${pkg.version}-`)) problems.push(`README.md: the version badge is not ${pkg.version}.`);

if (!fs.existsSync(vsce)) {
  console.error('vsce is missing: run npm ci first.');
  process.exit(1);
}
const packaged = new Set(run(['ls', '--no-dependencies']).split('\n').map(line => line.trim()).filter(Boolean));

// What the extension loads: its modules, the panel's scripts, the
// translations, and the files package.json names (main, icons).
const needed = new Set(['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE',
  ...list('.', '.json').filter(file => /^\.\/package\.nls(\.[\w-]+)?\.json$/.test(file)).map(file => file.slice(2)),
  ...list('l10n', '.json')]);
for (const file of list('src', '.js')) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  for (const [, request] of source.matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)) {
    const base = path.posix.join(path.posix.dirname(file), request);
    needed.add([base, `${base}.js`, `${base}.json`].find(candidate => fs.existsSync(path.join(root, candidate))) || `${base}.js`);
  }
  for (const [, name] of source.matchAll(/asset\('([^']+)'\)/g)) needed.add(`media/${name}`);
}
(function files(value) {
  if (typeof value === 'string') {
    if (/^(\.\/)?[\w.-]+(\/[\w.-]+)+\.\w+$/.test(value) && fs.existsSync(path.join(root, value))) needed.add(path.posix.normalize(value));
  } else if (value && typeof value === 'object') Object.values(value).forEach(files);
})(pkg);

for (const file of [...needed].sort()) if (!packaged.has(file)) problems.push(`${file} is needed but not packaged (check .vscodeignore).`);
const unwanted = new Map();
for (const file of [...packaged].sort()) {
  if (ALLOWED.some(pattern => pattern.test(file)) && !JUNK.test(file)) continue;
  const where = file.includes('/') && !JUNK.test(file) ? `${file.split('/')[0]}/` : file;
  unwanted.set(where, (unwanted.get(where) || 0) + 1);
}
for (const [where, count] of unwanted) problems.push(`${where}${count > 1 ? ` (${count} files)` : ''} must not be packaged (add it to .vscodeignore).`);

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });
run(['package', '--no-dependencies', '--out', vsix], { stdio: ['ignore', 'ignore', 'pipe'] });
const size = fs.statSync(vsix).size;
console.log(`${path.relative(process.cwd(), vsix) || vsix}: ${packaged.size} files, ${(size / 1024).toFixed(1)} KB`);
