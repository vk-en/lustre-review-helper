'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { resolveCommit, listCommits, readFileAtCommit, git } = require('./git');
const { BatchProgress } = require('./progress');
const { createAgentLauncher } = require('./codex');
const { LiveUsage } = require('./telemetry');
const { startClaudeMetrics } = require('./claude-metrics');
const { subjects: reviewSubjects } = require('./history');
const { gerritTarget, summaryEntry, resultKey } = require('./review-targets');
const { reviewSignature, signedReport } = require('./signature');
const { t } = require('./l10n');
const { verifyPatchProjects } = require('./gerrit-project');

const ACTIVE = new Set(['running', 'cancelling']);
const SHA = /^[a-f0-9]{40,64}$/;
const tickets = subjects => [...new Set(subjects.flatMap(subject => String(subject || '').match(/\b(?:EX|LU)-\d+\b/gi) || []).map(ticket => ticket.toUpperCase()))];

async function readJson(file) {
  const stat = await fs.stat(file);
  if (stat.size > 16 * 1024 * 1024) throw new Error('Review artifact is too large.');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function artifactPath(directory, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Invalid artifact path.');
  const root = await fs.realpath(directory);
  const file = await fs.realpath(path.resolve(root, relative));
  if (!file.startsWith(root + path.sep)) throw new Error('Artifact escapes its review directory.');
  return file;
}

async function artifact(directory, relative) {
  return readJson(await artifactPath(directory, relative));
}

async function failureDetails(directory, relative) {
  if (!relative) return undefined;
  let handle;
  try {
    const file = await artifactPath(directory, relative);
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, 65536));
    await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    const lines = buffer.toString('utf8').split('\n');
    if (size > buffer.length) lines.shift(); // The first JSON event may be partial.
    let lastMessage;
    let lastError;
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') lastMessage = event.item.text;
        if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          const text = event.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
          if (text) lastMessage = text;
        }
        if (event.type === 'result') {
          const errors = Array.isArray(event.errors) ? event.errors.filter(e => typeof e === 'string').join('\n') : '';
          if (errors || event.result) lastMessage = errors || event.result;
        }
        if (['turn.failed', 'error'].includes(event.type)) lastError = event.error?.message || event.message;
      } catch {
        if (/\bERROR\b|Error:/.test(line)) lastError = line;
      }
    }
    if (typeof lastMessage === 'string' && lastMessage.trim()) return lastMessage.trim().slice(-6000);
    if (typeof lastError === 'string') return lastError.trim().slice(-6000);
  } catch { /* Log diagnostics must never change the underlying review status. */ }
  finally { await handle?.close(); }
}

// The same patch, as lreview judges it: an identical range-diff, so a rebase
// alone is not a change.
async function samePatch(repo, earlier, sha) {
  if (earlier === sha) return true;
  try { return /^\s*1:\s+[0-9a-f]+\s+=\s+1:\s+[0-9a-f]+/.test(await git(repo, ['range-diff', '--no-color', '--creation-factor=999', `${earlier}^!`, `${sha}^!`])); }
  catch { return false; }
}

function reviewArguments(options, runDirectory) {
  const agent = options.agent || 'codex';
  const args = ['run', ...(!options.gerritPatches?.length ? ['--local'] : []), '--repo', options.repo, '--agent', agent,
    '--model', options.model, '--mode', options.mode, '--jobs', String(options.jobs),
    '--timeout', String(options.timeout), '--results-dir', path.join(runDirectory, 'artifacts'),
    '--worktrees-dir', path.join(runDirectory, 'worktrees')];
  // Do not let a review worker recursively call this same review service.
  // Include a valid transport even before the user has registered this MCP
  // server; an enabled=false-only table fails Codex config deserialization.
  if (agent === 'codex') args.push('--agent-arg=-c', '--agent-arg=mcp_servers.lreview_vscode={command="false",enabled=false}');
  else if (agent === 'claude') args.push('--agent-arg=--disallowedTools=mcp__lreview_vscode__*');
  if (options.effort) args.push('--effort', options.effort);
  if (options.promptsDir) args.push('--prompts-dir', options.promptsDir);
  // A re-review after fixing findings looks only at what changed since then.
  if (options.since && !options.gerritPatches?.length) args.push('--since', options.since);
  return [...args, ...(options.gerritPatches?.length ? options.gerritPatches.map(p => p.url) : options.commits)];
}

async function collectResults(directory, commits, patches = [], missingStatus = 'failed') {
  const summary = await readJson(path.join(directory, 'summary.json'));
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) throw new Error('Invalid lreview summary.');
  const results = [];
  for (const key of commits) {
    const entry = summaryEntry(summary, key, patches);
    if (!entry) {
      results.push({ target: key, sha: SHA.test(key) ? key : undefined, status: missingStatus,
        error: `lreview produced no result for ${key}. See the run log.`, message: '', comments: [] });
      continue;
    }
    const sha = entry.sha;
    const result = { sha, ...(key !== sha ? {target:key} : {}), subject: entry.subject, status: entry.status,
      severity: entry.severity, error: entry.error, tokens: entry.tokens, costUsd: entry.cost_usd,
      duration: entry.duration_s, message: '', comments: [] };
    if (entry.status === 'findings') {
      const report = await artifact(directory, entry.json);
      result.message = typeof report.message === 'string' ? report.message : '';
      if (!report.comments || typeof report.comments !== 'object' || Array.isArray(report.comments)) {
        throw new Error(`Invalid findings for ${sha.slice(0, 12)}.`);
      }
      for (const [file, comments] of Object.entries(report.comments)) {
        if (!Array.isArray(comments)) throw new Error('Invalid inline comments.');
        for (const comment of comments) {
          if (typeof comment.message !== 'string') throw new Error('Invalid finding message.');
          result.comments.push({ file, line: Number.isInteger(comment.line) && comment.line > 0 ? comment.line : 1,
            message: comment.message });
        }
      }
    } else if (entry.status !== 'clean') {
      result.diagnostic = await failureDetails(directory, entry.log);
    }
    results.push(result);
  }
  return results;
}

// The files of some reviews of a batch: their JSON, Markdown, log and telemetry.
async function removeArtifacts(directory, slugs) {
  for (const folder of [directory, path.join(directory, 'markdown')]) {
    let names;
    try { names = await fs.readdir(folder); } catch { continue; }
    for (const name of names) {
      if (slugs.some(slug => slug.test(name))) await fs.rm(path.join(folder, name), { force: true, recursive: false }).catch(() => {});
    }
  }
}

class ReviewService extends EventEmitter {
  constructor({ storage, settings, discoverModels, signature = run => reviewSignature('', run), spawnProcess = spawn }) {
    super();
    this.storage = storage;
    this.settings = settings;
    this.signature = signature;
    this.discoverModels = discoverModels;
    this.spawnProcess = spawnProcess;
    this.repositories = [];
    this.runs = new Map();
    this.children = new Map();
    this.starting = false;
    this.modelCache = new Map();
    this.pendingWrites = Promise.resolve();
    this.disposed = false;
  }

  async initialize() {
    await fs.mkdir(this.storage, { recursive: true, mode: 0o700 });
    for (const name of await fs.readdir(this.storage)) {
      if (!/^[a-f0-9-]{36}$/.test(name)) continue;
      try {
        const run = await readJson(path.join(this.storage, name, 'run.json'));
        if (run.id !== name || !Array.isArray(run.commits) || !run.commits.every(s => SHA.test(s) ||
          run.gerritPatches?.some(p => gerritTarget(p).id === s))) continue;
        // The first extension releases only supported Codex and omitted agent.
        run.agent ||= 'codex';
        if (ACTIVE.has(run.status)) {
          run.status = 'interrupted';
          run.error = 'VS Code closed before this review finished. Inspect its log before running it again.';
        }
        if (run.status === 'failed') {
          try { run.results = await collectResults(path.join(this.storage, name, 'artifacts'), run.commits, run.gerritPatches); }
          catch { /* Keep saved results if artifacts were removed or are incomplete. */ }
        }
        if (run.agent === 'auggie' && !ACTIVE.has(run.status) && run.usage?.tokens == null) {
          try {
            const usage = await new LiveUsage({ ...run, directory: path.join(this.storage, name) }).poll();
            if (usage.tokens !== null) {
              run.usage = { ...run.usage, tokens: usage.tokens, tokensPartial: usage.tokensPartial };
            }
          } catch { /* Older session files may have been removed. */ }
        }
        this.runs.set(name, run);
      } catch { /* An incomplete metadata write must not prevent extension activation. */ }
    }
  }

  setRepositories(repos) {
    this.repositories = [...new Set(repos)].map(repo => ({
      id: crypto.createHash('sha256').update(repo).digest('hex').slice(0, 16),
      path: repo, name: path.basename(repo),
    }));
  }

  repository(id) {
    const repo = id ? this.repositories.find(r => r.id === id || r.path === id) :
      (this.repositories.length === 1 ? this.repositories[0] : undefined);
    if (!repo) throw new Error('Choose one of the open workspace repositories. Use list_repositories to find its id.');
    return repo;
  }

  commits(repository, limit = 30) { return listCommits(this.repository(repository).path, limit); }

  async models(refresh = false, agent = 'codex') {
    if (!['codex', 'claude', 'auggie'].includes(agent)) throw new Error('Review agent must be codex, claude or auggie.');
    const cached = this.modelCache.get(agent);
    if (!refresh && cached && Date.now() - cached.time < 300000) return cached.models;
    const models = await this.discoverModels(agent);
    this.modelCache.set(agent, { time: Date.now(), models });
    return models;
  }

  history(repository, limit = 30) {
    return [...this.runs.values()].filter(r => !repository || r.repository === repository)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit)
      .map(({ log, results, ...run }) => ({ ...run, subjects: reviewSubjects({ ...run, results }),
        tickets: run.tickets || tickets((results || []).map(result => result.subject)) }));
  }

  get(id) {
    const run = this.runs.get(id);
    if (!run) throw new Error('Unknown review id.');
    // A removed workspace is no longer accessible to the bridge.
    this.repository(run.repository);
    return structuredClone(run);
  }

  persist(run) {
    const data = JSON.stringify(run, null, 2);
    const file = path.join(this.storage, run.id, 'run.json');
    this.pendingWrites = this.pendingWrites.catch(() => {}).then(async () => {
      await fs.writeFile(file + '.tmp', data, { mode: 0o600 });
      await fs.rename(file + '.tmp', file);
    });
    return this.pendingWrites;
  }

  async start(input) {
    if (this.disposed) throw new Error('The review service is shutting down.');
    if (this.starting || this.children.size || [...this.runs.values()].some(r => ACTIVE.has(r.status))) {
      throw new Error(t('A review batch is already running. Wait for it or cancel it first.'));
    }
    this.starting = true;
    let preparedRun;
    let metrics;
    try {
      const repo = this.repository(input.repository);
      if (input.gerritPatches !== undefined && !Array.isArray(input.gerritPatches)) throw new Error('Invalid Gerrit patch selection.');
      const patches = (input.gerritPatches || []).map(gerritTarget);
      if (new Set(patches.map(p => p.number)).size !== patches.length) throw new Error('Select each Gerrit change only once.');
      if (patches.length) await verifyPatchProjects(repo.path, patches);
      const refs = input.commits || (patches.length ? [] : ['HEAD']);
      if (!Array.isArray(refs) || refs.length + patches.length < 1 || refs.length + patches.length > 200) throw new Error('Choose 1–200 commits or Gerrit patches.');
      const localCommits = [...new Set(await Promise.all(refs.map(ref => resolveCommit(repo.path, ref))))];
      let since;
      if (input.since !== undefined) {
        if (typeof input.since !== 'string' || patches.length || localCommits.length !== 1) throw new Error('since needs exactly one local commit to review.');
        since = await resolveCommit(repo.path, input.since);
        if (await samePatch(repo.path, since, localCommits[0])) throw new Error(`Nothing changed since ${since.slice(0, 12)}: no review is due.`);
      }
      const commits = [...localCommits, ...patches.map(p => p.id)];
      const subjects = localCommits.length ? (await git(repo.path, ['log', '--no-walk', '--format=%H%x00%s', ...localCommits, '--']))
        .trim().split('\n').map(line => { const [sha, subject] = line.split('\0'); return { sha, subject }; }) : [];
      subjects.push(...patches.map(p => ({sha:p.id, subject:p.subject})));
      const agent = input.agent || 'codex';
      if (!['codex', 'claude', 'auggie'].includes(agent)) throw new Error('Review agent must be codex, claude or auggie.');
      const settings = await this.settings(agent);
      const models = await this.models(false, agent);
      const model = input.model ? models.find(m => m.id === input.model) : models.find(m => m.isDefault) || models[0];
      if (!model) throw new Error(t('The chosen model is absent from the {agent} catalog. Refresh the model list.', { agent }));
      const effort = input.effort || undefined;
      if (effort && !model.efforts.includes(effort)) throw new Error(t('This model does not support the selected reasoning effort.'));
      const mode = input.mode || settings.mode || 'full';
      if (!['full', 'light'].includes(mode)) throw new Error('Review mode must be full or light.');
      if (!Number.isInteger(settings.jobs) || settings.jobs < 1 || settings.jobs > 10) throw new Error('Invalid parallel review count.');
      if (!Number.isInteger(settings.timeout) || settings.timeout < 60 || settings.timeout > 28800) throw new Error('Invalid review timeout.');
      const id = crypto.randomUUID();
      const directory = path.join(this.storage, id);
      // Pin the CLI to the binary used for discovery, preserving sibling helpers.
      await createAgentLauncher(settings[agent], path.join(directory, 'bin'), agent);
      const run = { id, repository: repo.id, repo: repo.path, commits, subjects, tickets: tickets(subjects.map(c => c.subject)),
        ...(patches.length ? {gerritPatches:patches, localCommits} : {}), ...(since ? { since } : {}),
        agent, model: model.id, modelName: model.name, effort, mode, status: 'running', startedAt: new Date().toISOString(),
        source: input.source === 'mcp' ? 'mcp' : 'vscode', results: [], log: '',
        directory };
      preparedRun = run;
      run.signature = this.signature(run);
      this.runs.set(id, run);
      await this.persist(run);
      if (agent === 'claude') {
        // Telemetry availability must never prevent a review from running.
        metrics = await startClaudeMetrics().catch(() => undefined);
      }
      const batches = [
        ...(localCommits.length ? [{commits:localCommits, ...(since ? { since } : {})}] : []),
        ...(patches.length ? [{gerritPatches:patches}] : []),
      ];
      const processOptions = {
        cwd: repo.path, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${path.join(directory, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
          NO_COLOR: '1', PYTHONUNBUFFERED: '1', LREVIEW_PROMPTS_UPDATE: 'off',
          LREVIEW_VSCODE_WORKER: '1',
          AUGMENT_DISABLE_AUTO_UPDATE: '1',
          // Prevent an inherited LREVIEW_EFFORT from defeating the UI selection.
          LREVIEW_EFFORT: effort || '', ...metrics?.env },
      };
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      const active = { child: undefined, done };
      this.children.set(id, active);
      const telemetry = new LiveUsage(run, { claudeMetrics: metrics });
      let sampling;
      const sample = () => {
        if (!sampling) sampling = telemetry.poll().then(usage => {
          run.usage = usage;
          this.emit('changed', id);
        }).catch(() => {}).finally(() => { sampling = undefined; });
        return sampling;
      };
      const usageTimer = setInterval(sample, 1000);
      usageTimer.unref?.();
      // Each review's state, from lreview's log as it arrives.
      const progress = new BatchProgress(run);
      const log = chunk => {
        progress.feed(chunk);
        run.log = (run.log + chunk.toString()).slice(-32000);
        this.emit('log', { id, text: chunk.toString() });
        this.emit('changed', id);
      };
      const execute = async () => {
        try {
          run.exitCode = 0;
          // lreview's --local applies to the entire invocation. Keep local and
          // Gerrit inputs in consecutive batches sharing its merged manifest,
          // one usage tracker and one cancellable operation in the sidebar.
          for (const batch of batches) {
            if (run.status === 'cancelling') break;
            log(`\nReviewing ${batch.gerritPatches ? `${batch.gerritPatches.length} Gerrit patch(es)` : `${batch.commits.length} local commit(s)`}…\n`);
            const args = reviewArguments({ ...settings, ...batch, repo: repo.path, agent, model: model.id, effort, mode }, directory);
            const code = await new Promise((resolve, reject) => {
              let spawnError;
              const child = this.spawnProcess(settings.lreview, args, processOptions);
              active.child = child;
              child.stdout.on('data', log); child.stderr.on('data', log);
              child.on('error', error => { spawnError = error; });
              child.on('close', code => { active.child = undefined; spawnError ? reject(spawnError) : resolve(code); });
            });
            if (code !== 0) run.exitCode = code ?? 1;
            await sample();
          }
          try { run.results = await collectResults(path.join(directory, 'artifacts'), commits, patches, run.status === 'cancelling' ? 'cancelled' : 'failed'); }
          catch (error) { if (run.status !== 'cancelling') throw error; }
          if (run.status === 'cancelling') run.status = 'cancelled';
          else if (run.exitCode !== 0 || run.results.some(r => !['findings', 'clean'].includes(r.status))) {
            run.status = 'failed';
            run.error = `One or more reviews failed (exit ${run.exitCode}). See individual results and the log.`;
          } else run.status = 'completed';
        } catch (error) {
          // Collect what finished before announcing the end: a watcher that
          // sees the final status must also see the results.
          const cancelled = run.status === 'cancelling';
          try { run.results = await collectResults(path.join(directory, 'artifacts'), commits, patches, cancelled ? 'cancelled' : 'failed'); }
          catch { /* No usable manifest yet; retain the original error. */ }
          run.status = cancelled ? 'cancelled' : 'failed';
          run.error = error.message;
        } finally {
          clearInterval(usageTimer);
          await sampling;
          await sample();
          await metrics?.dispose();
          run.finishedAt = new Date().toISOString();
          await this.persist(run).catch(error => { run.error = `Cannot save review: ${error.message}`; });
          this.children.delete(id);
          this.emit('changed', id);
          this.emit('finished', id);
          finish();
        }
      };
      void execute();
      this.emit('changed', id);
      return this.get(id);
    } catch (error) {
      await metrics?.dispose();
      if (preparedRun && !this.children.has(preparedRun.id)) {
        preparedRun.status = 'failed';
        preparedRun.error = error.message;
        preparedRun.finishedAt = new Date().toISOString();
        await this.persist(preparedRun).catch(() => {});
        this.emit('changed', preparedRun.id);
      }
      throw error;
    } finally { this.starting = false; }
  }

  async cancel(id) {
    const run = this.runs.get(id);
    this.get(id);
    const active = this.children.get(id);
    if (active && ACTIVE.has(run.status)) {
      run.status = 'cancelling';
      // lreview handles SIGINT by terminating its agent process groups and
      // persisting partial results. SIGTERM would leave those groups alive.
      active.child?.kill('SIGINT');
      await this.persist(run);
      this.emit('changed', id);
    }
    return this.get(id);
  }

  // Deletes reviews for good, as Reports & History keeps only successful
  // reviews of work still open: a whole run with its directory, or some
  // commits of a batch with their own artifacts. A running review stays.
  async discard(id, keys) {
    const run = this.runs.get(id);
    if (!run || ACTIVE.has(run.status) || this.children.has(id)) return false;
    const drop = new Set(keys.filter(key => run.commits.includes(key)));
    if (!drop.size) return false;
    const directory = path.join(this.storage, id);
    await this.pendingWrites.catch(() => {});
    if (run.commits.every(key => drop.has(key))) {
      this.runs.delete(id);
      await fs.rm(directory, { recursive: true, force: true });
      return true;
    }
    const keep = key => !drop.has(key);
    const slugs = [...drop].map(key => {
      const patch = run.gerritPatches?.find(item => item.id === key);
      // lreview names a Gerrit review <change>_ps<patchset>, a local one <ref>_<first 7 digits>
      // and a local report <full SHA> Report.md.
      return patch ? new RegExp(`(^|[^0-9])${patch.number}_ps${patch.patchset}([^0-9]|$)`) : new RegExp(`(_${key.slice(0, 7)}([^0-9a-f]|$))|^${key}`);
    });
    run.commits = run.commits.filter(keep);
    run.results = (run.results || []).filter(result => keep(resultKey(result)));
    if (run.gerritPatches) run.gerritPatches = run.gerritPatches.filter(patch => keep(patch.id));
    if (run.subjects) run.subjects = run.subjects.filter(subject => keep(subject.sha));
    if (Array.isArray(run.localCommits)) run.localCommits = run.localCommits.filter(keep);
    for (const key of drop) { delete run.progress?.items?.[key]; delete run.usage?.byCommit?.[key]; }
    await removeArtifacts(path.join(directory, 'artifacts'), slugs);
    await this.persist(run);
    return true;
  }

  async finding(id, resultIndex, commentIndex) {
    const run = this.get(id);
    const result = run.results[resultIndex];
    const comment = result?.comments[commentIndex];
    if (!comment) throw new Error('Unknown finding.');
    return { ...comment, sha: result.sha,
      content: await readFileAtCommit(run.repo, result.sha, comment.file) };
  }

  async reportFiles(id, commit) {
    const run = this.get(id);
    if (commit !== undefined && !run.commits.includes(commit)) throw new Error('Unknown review commit.');
    const directory = path.join(this.storage, id, 'artifacts');
    let summary;
    try { summary = await readJson(path.join(directory, 'summary.json')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const files = [];
    if (!run.signature && !ACTIVE.has(run.status)) {
      this.runs.get(id).signature = run.signature = this.signature(run);
      await this.persist(this.runs.get(id));
    }
    for (const sha of run.commits) {
      if (commit && commit !== sha) continue;
      const entry = summaryEntry(summary, sha, run.gerritPatches);
      if (typeof entry?.markdown !== 'string' || !entry.markdown.endsWith('.md')) continue;
      try {
        const file = await artifactPath(directory, entry.markdown);
        if ((await fs.stat(file)).isFile()) {
          await fs.access(file, fs.constants.R_OK);
          if (run.signature && !ACTIVE.has(run.status)) {
            const original = await fs.readFile(file, 'utf8');
            const signed = signedReport(original, run.signature);
            if (signed !== original) await fs.writeFile(file, signed);
          }
          files.push(file);
        }
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return [...new Set(files)];
  }

  async dispose() {
    this.disposed = true;
    const active = [...this.children.entries()];
    // Repositories may already have been removed from VS Code at shutdown.
    for (const [id, process] of active) {
      const run = this.runs.get(id);
      if (ACTIVE.has(run.status)) {
        run.status = 'cancelling';
        process.child?.kill('SIGINT');
      }
    }
    await Promise.all(active.map(([, p]) => p.done));
    await this.pendingWrites;
  }
}

module.exports = { ReviewService, reviewArguments, collectResults, artifact, artifactPath };
