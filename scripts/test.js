'use strict';

// The offline tests: every test/*.test.js with Node's test runner, no npm or
// shell glob needed. A test that hangs fails after two minutes, and the run
// ends with the tests even if one left a timer or a socket open, so CI fails
// instead of waiting for its own time limit. Extra arguments go to the runner,
// e.g. --test-name-pattern=publish.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const folder = path.join(__dirname, '..', 'test');
const files = fs.readdirSync(folder).filter(name => name.endsWith('.test.js')).sort().map(name => path.join(folder, name));
const { status, signal, error } = spawnSync(process.execPath,
  ['--test', '--test-timeout=120000', '--test-force-exit', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
if (error) console.error(error.message);
process.exit(signal || error ? 1 : status);
