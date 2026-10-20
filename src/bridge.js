'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const repository = { type: 'string', description: 'Repository id returned by list_repositories. Required when several repositories are open.' };
const reviewId = { type: 'string', description: 'Review id returned by start_review.' };
const agent = { type: 'string', enum: ['codex', 'claude', 'auggie'], default: 'codex', description: 'Review backend. Omitted: Codex. Use claude for Claude Code or auggie for Augment.' };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
// What reviews carry about Gerrit, described once for every tool that returns it.
const GERRIT_STATE = 'A finished review includes gerrit_state: for a Gerrit patch, the reviewed and current patchset, whether a newer one changed files with findings ' +
  '(findings_may_be_outdated), merge conflict, CI, Code-Review votes, whether this review was published and other people\'s AI reviews of the same patchset; ' +
  'for a local commit, its Gerrit change (link: current, outdated, merged, abandoned or none) with that change\'s CI and votes.';
const TOOLS = [
  { name: 'list_repositories', description: 'List Git repositories open in the trusted VS Code workspace.', inputSchema: schema({}) },
  { name: 'list_commits', description: 'List recent commits, newest first. Only committed changes can be reviewed. Each commit with a Change-Id has gerrit: its change and link ' +
    '(current: Gerrit has this very commit; outdated: Gerrit has another version, push or pull; merged; abandoned; none: not on Gerrit), and merge_conflict when the change no longer merges and needs a rebase.',
    inputSchema: schema({ repository, limit: { type: 'integer', minimum: 1, maximum: 200, default: 30 } }) },
  { name: 'list_models', description: 'Discover the installed agent model catalog and supported reasoning efforts. Does not start inference.', inputSchema: schema({ agent }) },
  { name: 'start_review', description: 'Start an independent Lustre review using lreview and Codex, Claude Code or Augment. Reviews each selected commit in its own worktree; executes agent tools and consumes model usage. Returns immediately with an id; call get_review until completed, failed or cancelled. Does not publish to Gerrit. Do not call recursively from inside a review worker.',
    inputSchema: schema({ repository, agent, commits: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 200, description: 'Commit SHAs or local refs; defaults to ["HEAD"]. Each is reviewed separately.' },
      model: { type: 'string', description: 'Model id from list_models for the chosen agent; defaults to its catalog default.' },
      effort: { type: 'string', description: 'A supported effort from list_models.' }, mode: { type: 'string', enum: ['full', 'light'] },
      since: { type: 'string', description: 'Re-review after fixing findings: the commit reviewed before (reviewed_commit from find_reviews or get_selected_review). Only what changed since it is reviewed. Needs exactly one commit.' } }) },
  { name: 'get_review', description: 'Get review state, per-commit findings (file, line, message), the overall assessment and errors. Completed with no findings is distinct from failed or cancelled. ' +
    'While a batch runs, progress.items has each commit\'s state (queued, running, findings, clean, failed), time, findings count and cost. Once finished, reports lists each commit with its gerrit_state. ' +
    GERRIT_STATE + ' The run log is left out unless include_log is true.',
    inputSchema: schema({ id: reviewId, include_log: { type: 'boolean', default: false, description: 'Add the last part of the run log, for diagnosing a failed review.' } }, ['id']) },
  { name: 'find_reviews', description: 'Find earlier reviews of local commits, to fix their findings, or of a Gerrit change. Commits may be SHAs, branch names or other refs. Omitted: the current branch\'s commits not yet on its remote base branch (the local patch or series), else HEAD. A commit matches its own review or one of an earlier version with the same Change-Id (after amend or rebase). The newest match per commit includes its findings and gerrit_state. ' + GERRIT_STATE,
    inputSchema: schema({ repository, commits: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50, description: 'Commits to look up; defaults to the local series.' },
      subject: { type: 'string', description: 'Find reviews whose commit subject contains this text instead.' },
      change: { type: 'string', description: 'Find reviews of this Gerrit change instead: its number or review.whamcloud.com URL.' },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 3, description: 'Reviews per commit, newest first.' } }) },
  { name: 'get_selected_review', description: 'Get the review chosen in Reports & History in VS Code, with its findings, report file and gerrit_state. Returns null when nothing is chosen; ask the user to choose one. ' + GERRIT_STATE, inputSchema: schema({}) },
  { name: 'get_gerrit_queue', description: 'The Gerrit changes of this repository\'s project where the Gerrit account is a reviewer, as the Gerrit patches panel shows them. ' +
    'waiting_review: not reviewed or voted on yet. in_progress: already reviewed, with state new_patchset (uploaded since my review), owner_replied, waiting_for_author or my_plus_one. ' +
    'Each change has its CI (build, tests, failed tests), Code-Review votes, ready_for_landing (CI passed, no negative vote, two positive votes besides the owner), and this extension\'s AI review of the current patchset (ready or published) or other people\'s. ' +
    'Reads the last refresh, shared by all VS Code windows; refresh reads Gerrit again, which takes a few seconds. Does not change anything on Gerrit.',
    inputSchema: schema({ repository, refresh: { type: 'boolean', default: false, description: 'Read Gerrit again instead of the last refresh (refreshed_at).' } }) },
  { name: 'list_reviews', description: 'List recent review runs in an open repository, including runs started from the sidebar.', inputSchema: schema({ repository }) },
  { name: 'cancel_review', description: 'Cancel a running review, stop its agent processes and retain partial results.', inputSchema: schema({ id: reviewId }, ['id']) },
].map(tool => ({ ...tool, annotations: {
  readOnlyHint: !['start_review', 'cancel_review'].includes(tool.name),
  destructiveHint: false, idempotentHint: tool.name !== 'start_review',
  // Gerrit state and the queue are read from Gerrit.
  openWorldHint: !['list_repositories', 'list_reviews', 'cancel_review'].includes(tool.name),
} }));

// Logs can be megabytes; agents need findings, not the whole transcript.
const LOG_TAIL = 20000;
function reviewView(run, includeLog) {
  const { log, ...view } = run;
  return includeLog ? { ...view, log: typeof log === 'string' && log.length > LOG_TAIL ? log.slice(-LOG_TAIL) : log || '' } : view;
}

// extras carries what only the extension host has: the review lookup, the
// sidebar selection and the Gerrit state the panels show. This file is also
// copied for the agent-side MCP process, so it must not require other modules
// of the extension.
async function callTool(service, name, args = {}, extras = {}) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new Error('Unknown tool.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
  for (const field of tool.inputSchema.required) if (args[field] === undefined) throw new Error(`Missing ${field}.`);
  for (const [key, value] of Object.entries(args)) {
    const spec = tool.inputSchema.properties[key];
    if (!spec) throw new Error(`Unknown argument: ${key}.`);
    if (spec.type === 'string' && typeof value !== 'string') throw new Error(`${key} must be a string.`);
    if (spec.type === 'integer' && (!Number.isInteger(value) || value < spec.minimum || value > spec.maximum)) throw new Error(`Invalid ${key}.`);
    if (spec.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${key} must be true or false.`);
    if (spec.enum && !spec.enum.includes(value)) throw new Error(`Invalid ${key}.`);
    if (spec.type === 'array' && (!Array.isArray(value) || value.length < spec.minItems || value.length > spec.maxItems || !value.every(v => typeof v === 'string'))) throw new Error(`Invalid ${key}.`);
  }
  switch (name) {
    case 'list_repositories': return service.repositories;
    case 'list_commits': {
      const commits = await service.commits(args.repository, args.limit);
      return extras.commitLinks ? extras.commitLinks(args.repository, commits) : commits;
    }
    case 'list_models': return service.models(true, args.agent);
    case 'start_review': return service.start({ ...args, source: 'mcp' });
    case 'get_review': {
      const view = reviewView(service.get(args.id), args.include_log === true);
      return extras.reviewReports ? { ...view, ...(await extras.reviewReports(view.id)) } : view;
    }
    case 'find_reviews':
      if (!extras.findReviews) throw new Error('Review lookup is unavailable in this window.');
      return extras.findReviews(args);
    case 'get_selected_review': return extras.selectedReview ? extras.selectedReview() : null;
    case 'get_gerrit_queue':
      if (!extras.gerritQueue) throw new Error('The Gerrit queue is unavailable in this window.');
      return extras.gerritQueue(args);
    case 'list_reviews': return service.history(service.repository(args.repository).id);
    case 'cancel_review': return service.cancel(args.id);
  }
}

async function startBridge(service, connectionFile, extras = {}, { version } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const socketPath = path.join(os.tmpdir(), `lreview-${process.pid}-${crypto.randomBytes(6).toString('hex')}.sock`);
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const authorization = request.headers.authorization || '';
    const expected = `Bearer ${token}`;
    if (Buffer.byteLength(authorization) !== Buffer.byteLength(expected) ||
        !crypto.timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) {
      response.writeHead(403).end(JSON.stringify({ error: 'Unauthorized.' })); return;
    }
    if (request.method !== 'POST' || request.url !== '/tool') { response.writeHead(404).end('{}'); return; }
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 65536) throw new Error('Request too large.');
      }
      const message = JSON.parse(body);
      const result = await callTool(service, message.name, message.arguments, extras);
      response.end(JSON.stringify({ result }));
    } catch (error) { response.end(JSON.stringify({ error: error.message })); }
  });
  server.requestTimeout = 45000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o600);
  await fs.mkdir(path.dirname(connectionFile), { recursive: true, mode: 0o700 });
  // The version is for the agent-side process, which answers initialize itself.
  const data = { socketPath, token, ...(version ? { version } : {}) };
  await fs.writeFile(connectionFile + `.${process.pid}.tmp`, JSON.stringify(data), { mode: 0o600 });
  await fs.rename(connectionFile + `.${process.pid}.tmp`, connectionFile);
  return { async dispose() {
    await new Promise(resolve => server.close(resolve));
    try {
      const current = JSON.parse(await fs.readFile(connectionFile, 'utf8'));
      if (current.token === token) await fs.unlink(connectionFile);
    } catch { /* Another window may already own the connection file. */ }
    await fs.unlink(socketPath).catch(() => {});
  } };
}

async function bridgeRequest(connectionFile, name, args) {
  let connection;
  try { connection = JSON.parse(await fs.readFile(connectionFile, 'utf8')); }
  catch { throw new Error('Open the trusted project in VS Code with Lustre Review Helper enabled first.'); }
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: connection.socketPath, path: '/tool', method: 'POST',
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, timeout: 45000 }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const payload = JSON.parse(data);
          if (payload.error) reject(new Error(payload.error)); else resolve(payload.result);
        } catch (error) { reject(error); }
      });
    });
    request.on('error', error => reject(new Error(`Cannot reach Lustre Review Helper in VS Code: ${error.message}`)));
    request.on('timeout', () => request.destroy(new Error('VS Code review service timed out.')));
    request.end(JSON.stringify({ name, arguments: args }));
  });
}

module.exports = { TOOLS, callTool, startBridge, bridgeRequest };
