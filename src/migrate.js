'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// The identifiers the extension had before; VS Code names its storage folders
// after the identifier, so a new one starts empty.
const OLD_IDS = ['llm-code-and-review-tools.lustre-review'];

const exists = file => fs.stat(file).then(() => true, () => false);
async function empty(directory) {
  const entries = await fs.readdir(directory).catch(() => null);
  return !entries || entries.length === 0;
}

// Copies the reviews, statistics and published-review records of an earlier
// identifier into this one's folders, once: only into a folder that is still
// empty, and never deleting the old one. Returns the folders filled.
async function migrateStorage({ id, folders, oldIds = OLD_IDS }) {
  const filled = [];
  if (!id) return filled;
  for (const target of folders.filter(Boolean)) {
    if (!(await empty(target))) continue;
    for (const old of oldIds) {
      if (old.toLowerCase() === id.toLowerCase()) continue;
      const source = path.join(path.dirname(target), old);
      if (!(await exists(source)) || await empty(source)) continue;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.cp(source, target, { recursive: true, force: false, errorOnExist: false });
      filled.push(target);
      break;
    }
  }
  return filled;
}

module.exports = { migrateStorage, OLD_IDS };
