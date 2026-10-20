'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// A short lock shared by VS Code windows: a file created exclusively that holds
// the owner's pid. A lock left by a process that no longer exists is reclaimed.
async function fileLock(file, busyMessage, { timeout = 5000 } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lockFile = file + '.lock';
  const until = Date.now() + timeout;
  while (true) {
    try {
      const handle = await fs.open(lockFile, 'wx', 0o600);
      try { await handle.writeFile(String(process.pid)); }
      catch (error) { await handle.close(); await fs.unlink(lockFile); throw error; }
      return async () => { await handle.close(); await fs.unlink(lockFile).catch(() => {}); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = Number(await fs.readFile(lockFile, 'utf8'));
        let abandoned = false;
        if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); } catch (error) { abandoned = error.code === 'ESRCH'; }
        } else abandoned = Date.now() - (await fs.stat(lockFile)).mtimeMs > 30000;
        if (abandoned) { await fs.unlink(lockFile); continue; }
      } catch (error) { if (error.code === 'ENOENT') continue; }
      if (Date.now() >= until) throw new Error(busyMessage);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

module.exports = { fileLock };
