'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { migrateStorage } = require('../src/migrate');
const { temporary } = require('./helpers');

test('a new identifier takes over the storage of the old one, once', async t => {
  const root = await temporary(t);
  const global = path.join(root, 'globalStorage'), workspace = path.join(root, 'workspaceStorage', 'abc');
  const old = 'llm-code-and-review-tools.lustre-review', id = 'someone.lustre-review-helper';
  await fs.mkdir(path.join(global, old, 'mcp-runtime'), { recursive: true });
  await fs.writeFile(path.join(global, old, 'usage-statistics.json'), '{"rows":1}');
  await fs.mkdir(path.join(workspace, old, 'runs', 'r1'), { recursive: true });
  await fs.writeFile(path.join(workspace, old, 'runs', 'r1', 'run.json'), '{"id":"r1"}');
  const folders = [path.join(global, id), path.join(workspace, id)];

  assert.deepEqual(await migrateStorage({ id, folders }), folders);
  assert.equal(await fs.readFile(path.join(global, id, 'usage-statistics.json'), 'utf8'), '{"rows":1}');
  assert.equal(await fs.readFile(path.join(workspace, id, 'runs', 'r1', 'run.json'), 'utf8'), '{"id":"r1"}');
  assert.ok((await fs.stat(path.join(global, old, 'usage-statistics.json'))).isFile(), 'the old folder stays');

  // Once the new folder has data, it is never overwritten.
  await fs.writeFile(path.join(global, id, 'usage-statistics.json'), '{"rows":2}');
  assert.deepEqual(await migrateStorage({ id, folders }), []);
  assert.equal(await fs.readFile(path.join(global, id, 'usage-statistics.json'), 'utf8'), '{"rows":2}');
});

test('nothing moves under the old identifier itself, or without old data', async t => {
  const root = await temporary(t);
  const old = 'llm-code-and-review-tools.lustre-review';
  assert.deepEqual(await migrateStorage({ id: old, folders: [path.join(root, old)] }), []);
  assert.deepEqual(await migrateStorage({ id: 'someone.helper', folders: [path.join(root, 'someone.helper'), undefined] }), []);
  assert.deepEqual(await migrateStorage({ id: undefined, folders: [path.join(root, 'x')] }), []);
});
