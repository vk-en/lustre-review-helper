#!/usr/bin/env node
'use strict';

// Minimal stdio MCP transport: newline-delimited JSON-RPC, no runtime dependencies.
// Reviews are asynchronous jobs owned by VS Code, so tool calls stay short.
const readline = require('node:readline');
const fs = require('node:fs');
const { TOOLS, bridgeRequest } = require('./bridge');

// The extension writes its version into the connection file.
function connectionVersion(file) {
  try { const version = JSON.parse(fs.readFileSync(file, 'utf8')).version; return typeof version === 'string' && /^[\w.+-]{1,40}$/.test(version) ? version : undefined; }
  catch { return undefined; }
}

function serve(input, output, invoke, version = () => undefined) {
  let initialized = false;
  const send = payload => output.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n');
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on('line', async line => {
    let request;
    try { request = JSON.parse(line); }
    catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (!request || typeof request !== 'object' || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      send({ id: request?.id ?? null, error: { code: -32600, message: 'Invalid request' } }); return;
    }
    if (request.id === undefined) return; // initialized / cancelled notifications
    const { id, method, params } = request;
    try {
      if (method === 'initialize') {
        initialized = true;
        const versions = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
        send({ id, result: { protocolVersion: versions.includes(params?.protocolVersion) ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} }, serverInfo: { name: 'lreview-vscode', version: version() || 'unknown' },
          instructions: 'Reviews use the existing Lustre protocol. Call start_review once, then poll get_review; do not start recursive reviews. Only committed changes are reviewed, and nothing is published to Gerrit. The trusted VS Code workspace must remain open. ' +
            'To fix the findings of an earlier review: call find_reviews (without commits it looks up the current branch\'s local patch or series; or name a SHA, branch, subject or Gerrit change), or get_selected_review for the one chosen in VS Code. ' +
            'Fix the findings in the code, commit (amend the reviewed commit), then call start_review for that commit with since set to the reviewed_commit of the earlier review, so only the fix is reviewed, and poll get_review. ' +
            'Before fixing, check gerrit_state: findings_may_be_outdated means a newer patchset changed the files with findings. ' +
            'For Gerrit work: get_gerrit_queue lists the changes waiting for your review and those you reviewed with what happened since; list_commits shows each local commit\'s Gerrit change and whether it needs a rebase.' } });
      } else if (method === 'ping') send({ id, result: {} });
      else if (!initialized) send({ id, error: { code: -32002, message: 'Initialize first.' } });
      else if (method === 'tools/list') send({ id, result: { tools: TOOLS } });
      else if (method === 'tools/call') {
        try {
          if (!TOOLS.some(t => t.name === params?.name)) throw new Error('Unknown tool.');
          const result = await invoke(params.name, params.arguments || {});
          send({ id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
        } catch (error) { send({ id, result: { isError: true, content: [{ type: 'text', text: error.message }] } }); }
      } else send({ id, error: { code: -32601, message: 'Method not found' } });
    } catch (error) { send({ id, error: { code: -32603, message: error.message } }); }
  });
  return lines;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--connection' || process.env.LREVIEW_VSCODE_WORKER) {
    process.stderr.write('Usage: mcp.js --connection /absolute/path/connection.json. Unavailable inside review workers.\n');
    process.exitCode = 1;
  } else serve(process.stdin, process.stdout, (name, input) => bridgeRequest(args[1], name, input), () => connectionVersion(args[1]));
}

module.exports = { serve };
