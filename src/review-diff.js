'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const { git, safeGitPath } = require('./git');
const { t } = require('./l10n');

// Reviewed files are read straight from Git objects: no checkout, no worktree.
const SCHEME = 'lustre-review-diff';
const COMMIT_MSG = '/COMMIT_MSG';
const SHA = /^[a-f0-9]{40,64}$/;
const CATEGORY = /^\s*(?:\*\*)?\((defect|minor|suggestion|typo|style|nit)\)/i;
const commitMessageFile = file => ['/COMMIT_MSG', 'COMMIT_MSG', 'COMMIT_MESSAGE'].includes(file) ? COMMIT_MSG : file;

function show(repo, spec) {
  return new Promise((resolve, reject) => execFile('git', ['--no-pager', '-C', repo, 'show', spec], {
    encoding: 'buffer', timeout: 15000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

// Gerrit numbers commit-message comments in its /COMMIT_MSG layout: parent,
// author and committer lines, a blank line, then the message (subject on line 7).
async function commitMessage(repo, sha) {
  const [parents, author, authorDate, committer, commitDate, ...body] = (await git(repo,
    ['show', '-s', '--format=%P%x00%an <%ae>%x00%ai%x00%cn <%ce>%x00%ci%x00%B', sha])).split('\0');
  const list = parents.trim().split(/\s+/).filter(Boolean);
  const lines = [];
  for (const [index, parent] of list.entries()) {
    const subject = (await git(repo, ['show', '-s', '--format=%s', parent]).catch(() => '')).trim();
    lines.push(`${index ? '            ' : list.length > 1 ? 'Merge Of:   ' : 'Parent:     '}${parent.slice(0, 8)}${subject ? ` (${subject})` : ''}`);
  }
  return { parents: list, text: [...lines, `Author:     ${author}`, `AuthorDate: ${authorDate}`,
    `Commit:     ${committer}`, `CommitDate: ${commitDate}`, '', body.join('\0')].join('\n') };
}

async function changedFiles(repo, base, sha) {
  const fields = (await git(repo, base ? ['diff', '--no-color', '--no-ext-diff', '-z', '--name-status', '-M', base, sha, '--'] :
    ['diff-tree', '--root', '-r', '-z', '--name-status', '-M', '--no-commit-id', sha])).split('\0');
  const files = [];
  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++][0];
    const oldPath = fields[index++];
    const file = ['R', 'C'].includes(status) ? fields[index++] : oldPath;
    files.push({ status, oldPath, path: file });
  }
  return files;
}

// Changed line ranges on the reviewed side, per file, from a zero-context diff.
async function changedLines(repo, base, sha) {
  const ranges = new Map();
  if (!base) return ranges;
  let file;
  for (const line of (await git(repo, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-U0', '-M', base, sha, '--'])).split('\n')) {
    if (line.startsWith('+++ ')) { file = line.startsWith('+++ b/') ? line.slice(6) : undefined; continue; }
    const hunk = file && line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!hunk) continue;
    const start = Math.max(1, Number(hunk[1])), count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    // A pure deletion still shows context around the point where lines were removed.
    ranges.set(file, [...(ranges.get(file) || []), [start, start + Math.max(count, 1) - 1]]);
  }
  return ranges;
}

// The lines VS Code leaves visible when it hides unchanged regions: each change
// with its context lines, plus gaps too short to hide.
function visibleLines(ranges, lineCount, context = 3, minimum = 3) {
  const shown = [];
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const range = [Math.max(1, start - context), Math.min(lineCount, end + context)];
    const last = shown.at(-1);
    if (last && range[0] - last[1] - 1 < minimum) last[1] = Math.max(last[1], range[1]);
    else shown.push(range);
  }
  if (shown.length && shown[0][0] - 1 < minimum) shown[0][0] = 1;
  if (shown.length && lineCount - shown.at(-1)[1] < minimum) shown.at(-1)[1] = lineCount;
  return shown;
}

async function prepare(repo, sha) {
  if (!SHA.test(sha || '')) throw new Error('This review has no reviewed commit to compare.');
  try { await git(repo, ['cat-file', '-e', `${sha}^{commit}`]); }
  catch { throw new Error(`The reviewed commit ${sha.slice(0, 12)} is no longer in the local repository. Fetch it or run the review again.`); }
  const message = await commitMessage(repo, sha);
  const base = message.parents[0];
  const [files, changed] = await Promise.all([changedFiles(repo, base, sha), changedLines(repo, base, sha)]);
  return { base, files, changed, message: message.text };
}

const LANGUAGES = { c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', py: 'python', sh: 'shellscript', bash: 'shellscript',
  pl: 'perl', rs: 'rust', go: 'go', js: 'javascript', ts: 'typescript', java: 'java', json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown' };
function excerpt(file, text, line) {
  const lines = text.split('\n'), first = Math.max(1, line - 2), last = Math.min(lines.length, line + 2);
  const code = lines.slice(first - 1, last).map((value, index) => `${String(first + index).padStart(String(last).length)}  ${value}`).join('\n');
  const fence = code.includes('```') ? '````' : '```';
  return `${fence}${LANGUAGES[file.split('.').pop()] || ''}\n${code}\n${fence}`;
}

class ReviewDiff {
  constructor(vscode) {
    this.vscode = vscode;
    this.sessions = new Map();
    this.threads = new Map();
  }

  uri(key, side, file) {
    return this.vscode.Uri.from({ scheme: SCHEME, path: file === COMMIT_MSG ? COMMIT_MSG : `/${file}`,
      query: new URLSearchParams({ review: key, side }).toString() });
  }

  async provideTextDocumentContent(uri) {
    const params = new URLSearchParams(uri.query);
    const session = this.sessions.get(params.get('review'));
    if (!session) return t('This review diff is no longer available. Open it again from Reports & History.');
    const head = params.get('side') === 'head';
    if (uri.path === COMMIT_MSG) return head ? session.message : '';
    const file = uri.path.slice(1), revision = head ? session.sha : session.base;
    if (!revision || !safeGitPath(file)) return '';
    try {
      const data = await show(session.repo, `${revision}:${file}`);
      return data.subarray(0, 8000).includes(0) ? t('Binary file not shown.') : data.toString('utf8');
    } catch { return ''; } // The side where the file was added or deleted.
  }

  async place(prepared, repo, sha, comments) {
    const settings = this.vscode.workspace?.getConfiguration?.('diffEditor');
    const context = settings?.get('hideUnchangedRegions.contextLineCount') ?? 3, minimum = settings?.get('hideUnchangedRegions.minimumLineCount') ?? 3;
    const contents = new Map();
    const content = async file => {
      if (!contents.has(file)) contents.set(file, await show(repo, `${sha}:${file}`).then(data => data.toString('utf8'), () => undefined));
      return contents.get(file);
    };
    // Gerrit unfolds code around every comment; VS Code hides unchanged code even
    // under a comment. Such a finding moves to the nearest visible line, quoting
    // the code it is about, so it is never hidden.
    const placements = [];
    for (const comment of comments) {
      const file = commitMessageFile(comment.file), line = Number.isInteger(comment.line) && comment.line > 0 ? comment.line : 1;
      const entry = file === COMMIT_MSG ? undefined : prepared.files.find(item => item.path === file);
      if (file === COMMIT_MSG) { placements.push({ comment, side: 'head', file, line }); continue; }
      if (!entry) {
        const text = safeGitPath(file) ? await content(file) : undefined;
        placements.push({ comment, side: 'head', file: COMMIT_MSG, line: 1,
          prefix: text === undefined ? `**${file}:${line}**` : `**${file}:${line}** · ${t('unchanged file')}\n\n${excerpt(file, text, line)}` });
        continue;
      }
      if (entry.status === 'D') { placements.push({ comment, side: 'base', file: entry.oldPath, line }); continue; }
      const ranges = prepared.changed.get(file), text = ranges && entry.status !== 'A' ? await content(file) : undefined;
      const shown = text === undefined ? [] : visibleLines(ranges, text.split('\n').length, context, minimum);
      if (!shown.length || shown.some(([first, last]) => line >= first && line <= last)) { placements.push({ comment, side: 'head', file, line }); continue; }
      const anchor = shown.map(([first, last]) => line < first ? first : last)
        .reduce((best, candidate) => Math.abs(candidate - line) < Math.abs(best - line) ? candidate : best);
      placements.push({ comment, side: 'head', file, line: anchor, prefix: `**${t('Line {n}', { n: line })}** · ${t('unchanged code')}\n\n${excerpt(file, text, line)}` });
    }
    return placements;
  }

  // The Comments panel lists the findings of one review at a time: the one
  // chosen in Reports & History. Clicking a finding there opens the reviewed
  // file at its line, with or without the diff.
  async show({ key, repo, sha, comments = [], author = '[AI review]' }, isCurrent = () => true) {
    const identity = JSON.stringify([key, sha, comments, author]);
    if (this.current?.identity === identity) return this.current;
    const vscode = this.vscode;
    const prepared = await prepare(repo, sha);
    const placements = await this.place(prepared, repo, sha, comments);
    if (!isCurrent()) return undefined;
    this.sessions.set(key, { repo, sha, base: prepared.base, message: prepared.message });
    this.clear();
    this.controller ||= vscode.comments.createCommentController('lustreReview.findings', 'Lustre Review Helper');
    const threads = placements.map(({ comment, side, file, line, prefix }) => {
      const thread = this.controller.createCommentThread(this.uri(key, side, file), new vscode.Range(line - 1, 0, line - 1, 0), [{
        body: new vscode.MarkdownString(prefix ? `${prefix}\n\n${comment.message}` : comment.message), mode: vscode.CommentMode.Preview, author: { name: author } }]);
      const category = String(comment.message).match(CATEGORY)?.[1]?.toLowerCase();
      if (category) thread.label = { defect: t('Defect'), minor: t('Minor'), suggestion: t('Suggestion'), typo: t('Typo'), style: t('Style'), nit: t('Nit') }[category];
      thread.canReply = false;
      thread.contextValue = 'lustreReviewFinding';
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      return thread;
    });
    this.threads.set(key, threads);
    this.current = { identity, key, prepared, placements };
    return this.current;
  }

  clear() {
    for (const threads of this.threads.values()) for (const thread of threads) thread.dispose();
    this.threads.clear();
    this.current = undefined;
  }

  // Unresolved Gerrit discussions of the reviewed patchset, shown beside our
  // findings. They follow the same visibility rules, keep every reply and are
  // replaced when the diff opens again or another review is chosen.
  async discuss(key, repo, sha, prepared, discussions) {
    const vscode = this.vscode;
    for (const thread of this.threads.get(`${key}#gerrit`) || []) thread.dispose();
    const placements = await this.place(prepared, repo, sha, discussions.map(discussion => ({
      file: discussion.patchsetLevel ? COMMIT_MSG : discussion.file, line: discussion.patchsetLevel ? 1 : discussion.line, message: '' })));
    if (this.current?.key !== key) return [];
    const stamp = value => { const date = new Date(String(value).replace(' ', 'T').slice(0, 23) + 'Z'); return Number.isNaN(date.getTime()) ? {} : { timestamp: date }; };
    const threads = placements.map(({ side, file, line, prefix }, index) => {
      const discussion = discussions[index];
      const header = [discussion.patchsetLevel ? `**${t('Patchset comment')}**` : '', prefix || ''].filter(Boolean).join('\n\n');
      const thread = this.controller.createCommentThread(this.uri(key, side, file), new vscode.Range(line - 1, 0, line - 1, 0),
        discussion.comments.map((comment, position) => ({ body: new vscode.MarkdownString(position === 0 && header ? `${header}\n\n${comment.message}` : comment.message),
          mode: vscode.CommentMode.Preview, author: { name: comment.author }, ...stamp(comment.updated) })));
      thread.label = `Gerrit · ${t('unresolved')}`;
      thread.canReply = false;
      thread.contextValue = 'lustreReviewGerrit';
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      return thread;
    });
    this.threads.set(`${key}#gerrit`, threads);
    return placements;
  }

  async open({ key, repo, sha, title, comments = [], author = '[AI review]', scope = 'commented', discussions, wait = 6000, only }) {
    // Gerrit is asked in parallel; a slow answer never holds the diff back.
    const settled = discussions && Promise.race([discussions.catch(() => null), new Promise(resolve => setTimeout(resolve, wait, null))]);
    const [{ prepared, placements }, early] = await Promise.all([this.show({ key, repo, sha, comments, author }), settled]);
    const external = early ? await this.discuss(key, repo, sha, prepared, early) : [];
    if (discussions && !early) discussions.then(list => { if (list && this.current?.key === key) return this.discuss(key, repo, sha, prepared, list); }).catch(() => {});
    // One file with findings, chosen in Reports & History: a plain diff of it.
    if (only) {
      const entry = only === COMMIT_MSG ? { path: COMMIT_MSG, oldPath: COMMIT_MSG } : prepared.files.find(item => item.path === only || item.oldPath === only);
      if (!entry) throw new Error(t('This file is not part of the reviewed commit.'));
      await this.vscode.commands.executeCommand('vscode.diff', this.uri(key, 'base', entry.oldPath), this.uri(key, 'head', entry.path),
        `${title} · ${entry.path === COMMIT_MSG ? t('Commit message') : path.posix.basename(entry.path)}`);
      return { scope: 'file', files: 1, total: prepared.files.length + 1, comments: placements.length, discussions: external.length };
    }
    // A clean review has nothing to filter by; show every changed file.
    const effective = scope === 'commented' && (placements.length || external.length) ? 'commented' : 'all';
    const commented = new Set([...placements, ...external].map(placement => placement.file));
    const files = effective === 'all' ? prepared.files : prepared.files.filter(entry => commented.has(entry.path) || commented.has(entry.oldPath));
    const message = effective === 'all' || commented.has(COMMIT_MSG);
    const suffix = effective === 'commented' ? t('files with comments') : scope === 'commented' ? t('all files (no comments)') : t('all files');
    await this.vscode.commands.executeCommand('vscode.changes', `${title} · ${suffix}${external.length ? ` · ${t('{n} unresolved in Gerrit', { n: external.length })}` : ''}`, [
      ...(message ? [[this.uri(key, 'head', COMMIT_MSG), this.uri(key, 'base', COMMIT_MSG), this.uri(key, 'head', COMMIT_MSG)]] : []),
      ...files.map(entry => [this.uri(key, 'head', entry.path), this.uri(key, 'base', entry.oldPath), this.uri(key, 'head', entry.path)]),
    ]);
    return { scope: effective, files: files.length + (message ? 1 : 0), total: prepared.files.length + 1, comments: placements.length, discussions: external.length };
  }

  // A commit of Local commits, as a review's diff opens but without findings:
  // the commit message, then every changed file against the parent. The
  // findings shown for the review chosen in Reports & History stay.
  async openCommit({ repo, sha, title }) {
    const key = `commit:${sha}`, prepared = await prepare(repo, sha);
    this.sessions.set(key, { repo, sha, base: prepared.base, message: prepared.message });
    await this.vscode.commands.executeCommand('vscode.changes', title, [
      [this.uri(key, 'head', COMMIT_MSG), this.uri(key, 'base', COMMIT_MSG), this.uri(key, 'head', COMMIT_MSG)],
      ...prepared.files.map(entry => [this.uri(key, 'head', entry.path), this.uri(key, 'base', entry.oldPath), this.uri(key, 'head', entry.path)]),
    ]);
    return { files: prepared.files.length + 1 };
  }

  dispose() {
    this.clear(); this.sessions.clear();
    this.controller?.dispose();
  }
}

module.exports = { SCHEME, COMMIT_MSG, ReviewDiff, prepare, commitMessage, changedFiles, changedLines, visibleLines };
