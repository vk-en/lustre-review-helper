'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ReviewDiff, prepare, visibleLines, COMMIT_MSG } = require('../src/review-diff');
const { repository } = require('./helpers');

const longFile = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);

async function fixture(t) {
  const repo = await repository(t);
  const write = (file, text) => fs.writeFile(path.join(repo.directory, file), text);
  await write('kept.c', 'one\ntwo\nthree\n');
  await write('old.c', 'moved\ncontent\nstays\nthe\nsame\n');
  await write('gone.c', 'removed\n');
  await write('context.c', 'unchanged context\nline two\n');
  await write('long.c', longFile.join('\n') + '\n');
  repo.git('add', '.'); repo.git('commit', '-qm', 'LU-1 base: first');
  const parent = repo.git('rev-parse', 'HEAD');
  await write('kept.c', 'one\nTWO\nthree\n');
  await write('added.c', 'new file\n');
  await write('long.c', longFile.map((line, index) => index === 4 ? 'line 5 changed' : line).join('\n') + '\n');
  repo.git('mv', 'old.c', 'new.c');
  repo.git('rm', '-q', 'gone.c');
  repo.git('add', '.');
  repo.git('commit', '-qm', 'LU-2 llite: change things\n\nBody line one.\n\nFixes: 0123456789ab ("LU-1 base: first")');
  return { repo, parent, sha: repo.git('rev-parse', 'HEAD') };
}

function fakeVscode() {
  const threads = [], commands = [];
  const vscode = {
    Uri: { from: parts => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}?${parts.query}` }) },
    Range: class { constructor(startLine, startCharacter, endLine, endCharacter) { Object.assign(this, { startLine, startCharacter, endLine, endCharacter }); } },
    MarkdownString: class { constructor(value) { this.value = value; } },
    CommentMode: { Preview: 1 }, CommentThreadCollapsibleState: { Expanded: 1 },
    comments: { createCommentController: (id, label) => ({ id, label, dispose() { this.disposed = true; },
      createCommentThread: (uri, range, comments) => { const thread = { uri, range, comments, dispose() { this.disposed = true; } }; threads.push(thread); return thread; } }) },
    commands: { executeCommand: async (...args) => commands.push(args) },
  };
  return { vscode, threads, commands };
}

const comments = [
  { file: '/COMMIT_MSG', line: 11, message: '(minor) Which defect does this fix?' },
  { file: 'kept.c', line: 2, message: '**(defect)** Check this value.' },
  { file: 'gone.c', line: 1, message: '(suggestion) Why remove this?' },
  { file: 'context.c', line: 1, message: 'Context finding.' },
  { file: 'missing.c', line: 9, message: '(nit) Elsewhere.' },
  { file: 'long.c', line: 7, message: '(style) Near the change.' },
  { file: 'long.c', line: 40, message: '(style) Now unused.' },
];

test('review diffs list the reviewed commit against its parent in Gerrit commit-message layout', async t => {
  const { repo, parent, sha } = await fixture(t);
  const prepared = await prepare(repo.directory, sha);
  assert.equal(prepared.base, parent);
  assert.deepEqual(prepared.files.map(f => [f.status, f.oldPath, f.path]).sort(), [
    ['A', 'added.c', 'added.c'], ['D', 'gone.c', 'gone.c'], ['M', 'kept.c', 'kept.c'], ['M', 'long.c', 'long.c'], ['R', 'old.c', 'new.c']]);
  assert.deepEqual(prepared.changed.get('long.c'), [[5, 5]]);
  const lines = prepared.message.split('\n');
  assert.match(lines[0], new RegExp(`^Parent:     ${parent.slice(0, 8)} \\(LU-1 base: first\\)$`));
  assert.match(lines[1], /^Author:     Test Author <test@example\.invalid>$/);
  assert.match(lines[2], /^AuthorDate: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4}$/);
  assert.equal(lines[5], '');
  assert.equal(lines[6], 'LU-2 llite: change things', 'Gerrit puts the subject on line 7');
  assert.equal(lines[10], 'Fixes: 0123456789ab ("LU-1 base: first")');
  await assert.rejects(prepare(repo.directory, 'f'.repeat(40)), /no longer in the local repository/);
  await assert.rejects(prepare(repo.directory, 'HEAD'), /no reviewed commit/);
});

test('visible lines follow VS Code: three context lines per change, short gaps stay open', () => {
  assert.deepEqual(visibleLines([[5, 5]], 61), [[1, 8]]);
  assert.deepEqual(visibleLines([[5, 5], [12, 12]], 100), [[1, 15]]);
  assert.deepEqual(visibleLines([[20, 20], [5, 5]], 100), [[1, 8], [17, 23]]);
  assert.deepEqual(visibleLines([[95, 96]], 100), [[92, 100]]);
  assert.deepEqual(visibleLines([[30, 30]], 100, 5, 3), [[25, 35]]);
});

test('review diffs place each finding where it is visible, never drop one and read files without a checkout', async t => {
  const { repo, sha } = await fixture(t);
  const { vscode, threads, commands } = fakeVscode();
  const diff = new ReviewDiff(vscode);
  const opened = await diff.open({ key: 'run:1', repo: repo.directory, sha, title: 'Review · LU-2', comments, author: '[Lustre Bot]' });
  assert.deepEqual(opened, { scope: 'commented', files: 4, total: 6, comments: 7, discussions: 0 });
  const [command, title, resources] = commands[0];
  assert.equal(command, 'vscode.changes');
  assert.equal(title, 'Review · LU-2 · files with comments');
  assert.deepEqual(resources.map(entry => entry[0].path), [COMMIT_MSG, '/gone.c', '/kept.c', '/long.c'],
    'only the message and files with findings, the message first as in Gerrit');
  const place = thread => [thread.uri.path, new URLSearchParams(thread.uri.query).get('side'), thread.range.startLine, thread.label];
  assert.deepEqual(threads.map(place), [
    [COMMIT_MSG, 'head', 10, 'Minor'], ['/kept.c', 'head', 1, 'Defect'], ['/gone.c', 'base', 0, 'Suggestion'],
    [COMMIT_MSG, 'head', 0, undefined], [COMMIT_MSG, 'head', 0, 'Nit'], ['/long.c', 'head', 6, 'Style'], ['/long.c', 'head', 7, 'Style']]);
  const body = index => threads[index].comments[0].body.value;
  assert.equal(body(3), '**context.c:1** · unchanged file\n\n```c\n1  unchanged context\n2  line two\n3  \n```\n\nContext finding.');
  assert.equal(body(4), '**missing.c:9**\n\n(nit) Elsewhere.');
  assert.equal(body(5), '(style) Near the change.', 'a finding inside the visible context stays on its line');
  assert.equal(body(6), '**Line 40** · unchanged code\n\n```c\n38  line 38\n39  line 39\n40  line 40\n41  line 41\n42  line 42\n```\n\n(style) Now unused.',
    'a finding in hidden unchanged code moves to the nearest visible line and quotes its code');
  assert.equal(threads[1].comments[0].author.name, '[Lustre Bot]');
  assert.ok(threads.every(thread => thread.canReply === false));
  const content = (side, file) => diff.provideTextDocumentContent(diff.uri('run:1', side, file));
  assert.equal(await content('head', 'kept.c'), 'one\nTWO\nthree\n');
  assert.equal(await content('base', 'kept.c'), 'one\ntwo\nthree\n');
  assert.equal(await content('base', 'added.c'), '');
  assert.equal(await content('head', 'gone.c'), '');
  assert.equal(await content('base', COMMIT_MSG), '');
  assert.equal((await content('head', COMMIT_MSG)).split('\n')[10], 'Fixes: 0123456789ab ("LU-1 base: first")');
  repo.git('checkout', '-q', 'HEAD~1');
  assert.equal(await content('head', 'kept.c'), 'one\nTWO\nthree\n', 'the worktree is never read');

  await diff.open({ key: 'run:1', repo: repo.directory, sha, title: 'Review · LU-2', comments: comments.slice(1, 2), scope: 'all' });
  assert.ok(threads.slice(0, 7).every(thread => thread.disposed), 'reopening replaces the previous threads');
  assert.equal(commands[1][1], 'Review · LU-2 · all files');
  assert.deepEqual(commands[1][2].map(entry => entry[0].path), [COMMIT_MSG, '/added.c', '/gone.c', '/kept.c', '/long.c', '/new.c']);
  assert.equal(commands[1][2].find(entry => entry[0].path === '/new.c')[1].path, '/old.c', 'a rename compares with the old path');
  const clean = await diff.open({ key: 'run:2', repo: repo.directory, sha, title: 'Review · LU-2', comments: [] });
  assert.equal(clean.scope, 'all', 'a review without findings shows every file');
  assert.equal(commands[2][1], 'Review · LU-2 · all files (no comments)');
  // One file with findings, chosen from Reports & History.
  const single = await diff.open({ key: 'run:1', repo: repo.directory, sha, title: 'Review · LU-2', comments, only: 'new.c' });
  assert.equal(single.scope, 'file');
  assert.deepEqual([commands[3][0], commands[3][1].path, commands[3][2].path, commands[3][3]], ['vscode.diff', '/old.c', '/new.c', 'Review · LU-2 · new.c'],
    'a renamed file compares with its old path');
  await diff.open({ key: 'run:1', repo: repo.directory, sha, title: 'Review · LU-2', comments, only: COMMIT_MSG });
  assert.deepEqual([commands[4][1].path, commands[4][2].path, commands[4][3]], [COMMIT_MSG, COMMIT_MSG, 'Review · LU-2 · Commit message']);
  await assert.rejects(diff.open({ key: 'run:1', repo: repo.directory, sha, title: 'T', comments, only: 'nope.c' }), /not part of the reviewed commit/);
  assert.match(await diff.provideTextDocumentContent(diff.uri('other', 'head', 'kept.c')), /no longer available/);
  diff.dispose();
  assert.ok(threads.every(thread => thread.disposed));
});

test('a commit opens in the same diff, without findings and without touching those of the shown review', async t => {
  const { repo, sha } = await fixture(t);
  const { vscode, threads, commands } = fakeVscode();
  const diff = new ReviewDiff(vscode);
  await diff.show({ key: 'a', repo: repo.directory, sha, comments: comments.slice(0, 2) });
  assert.deepEqual(await diff.openCommit({ repo: repo.directory, sha, title: 'Commit abc · LU-2 llite: change things' }), { files: 6 });
  const [command, title, entries] = commands.at(-1);
  assert.deepEqual([command, title], ['vscode.changes', 'Commit abc · LU-2 llite: change things']);
  assert.deepEqual(entries.map(entry => entry[0].path), ['/COMMIT_MSG', '/added.c', '/gone.c', '/kept.c', '/long.c', '/new.c']);
  assert.ok(threads.every(thread => !thread.disposed), 'the findings of the shown review stay');
  assert.match(await diff.provideTextDocumentContent(entries[0][0]), /^Parent: {5}[0-9a-f]{8} \(LU-1 base: first\)/);
  assert.equal(await diff.provideTextDocumentContent(entries[3][1]), 'one\ntwo\nthree\n');
  assert.equal(await diff.provideTextDocumentContent(entries[3][0]), 'one\nTWO\nthree\n');
});

test('the Comments panel holds one review at a time and ignores a choice that is no longer current', async t => {
  const { repo, sha } = await fixture(t);
  const { vscode, threads, commands } = fakeVscode();
  const diff = new ReviewDiff(vscode);
  const first = await diff.show({ key: 'a', repo: repo.directory, sha, comments: comments.slice(0, 2) });
  assert.equal(threads.length, 2);
  assert.equal(await diff.show({ key: 'a', repo: repo.directory, sha, comments: comments.slice(0, 2) }), first, 'the same review is not rebuilt');
  assert.equal(threads.length, 2);
  await diff.show({ key: 'b', repo: repo.directory, sha, comments: comments.slice(2, 3) });
  assert.deepEqual(threads.map(thread => !!thread.disposed), [true, true, false], 'choosing another review replaces the findings');
  assert.equal(await diff.show({ key: 'c', repo: repo.directory, sha, comments: comments.slice(3, 4) }, () => false), undefined);
  assert.equal(threads.length, 3, 'a stale choice creates nothing');
  await diff.open({ key: 'b', repo: repo.directory, sha, title: 'T', comments: comments.slice(2, 3) });
  assert.equal(threads.length, 3, 'opening the diff of the shown review reuses its findings');
  assert.deepEqual(commands[0][2].map(entry => entry[0].path), ['/gone.c']);
  diff.clear();
  assert.ok(threads.every(thread => thread.disposed), 'a review without findings empties the panel');
  assert.match(await diff.provideTextDocumentContent(diff.uri('b', 'base', 'gone.c')), /removed/, 'open documents keep their content');
});

test('unresolved Gerrit discussions join the diff, also when Gerrit answers late, and never hold it back', async t => {
  const { repo, sha } = await fixture(t);
  const { vscode, threads, commands } = fakeVscode();
  const diff = new ReviewDiff(vscode);
  const discussion = (file, line, extra = {}) => ({ file, line, patchsetLevel: false, ...extra,
    comments: [{ author: 'Other Reviewer', message: 'Why?', updated: '2026-10-16 10:00:00.000000000' }, { author: 'Owner', message: 'Because.', updated: 'bad date' }] });
  const opened = await diff.open({ key: 'r', repo: repo.directory, sha, title: 'T', comments: [comments[1]],
    discussions: Promise.resolve([discussion('added.c', 1), discussion('long.c', 40), discussion('/PATCHSET_LEVEL', 1, { patchsetLevel: true })]) });
  assert.equal(opened.discussions, 3);
  assert.equal(commands[0][1], 'T · files with comments · 3 unresolved in Gerrit');
  assert.deepEqual(commands[0][2].map(entry => entry[0].path), [COMMIT_MSG, '/added.c', '/kept.c', '/long.c'], 'files with Gerrit discussions are shown too');
  const gerrit = threads.filter(thread => thread.label === 'Gerrit · unresolved');
  assert.deepEqual(gerrit.map(thread => [thread.uri.path, thread.range.startLine, thread.comments.length]), [['/added.c', 0, 2], ['/long.c', 7, 2], [COMMIT_MSG, 0, 2]]);
  assert.match(gerrit[1].comments[0].body.value, /^\*\*Line 40\*\* · unchanged code/, 'a discussion on hidden code moves like a finding');
  assert.match(gerrit[2].comments[0].body.value, /^\*\*Patchset comment\*\*\n\nWhy\?$/);
  assert.equal(gerrit[0].comments[1].author.name, 'Owner');
  assert.ok(gerrit[0].comments[0].timestamp instanceof Date && !('timestamp' in gerrit[0].comments[1]));
  assert.ok(gerrit.every(thread => thread.canReply === false));

  let answer;
  const late = new Promise(resolve => { answer = resolve; });
  const reopened = await diff.open({ key: 'r', repo: repo.directory, sha, title: 'T', comments: [comments[1]], discussions: late, wait: 20 });
  assert.equal(reopened.discussions, 0, 'a slow Gerrit does not hold the diff back');
  assert.ok(gerrit.every(thread => !thread.disposed), 'earlier discussions stay until new ones arrive');
  answer([discussion('kept.c', 2)]);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(gerrit.every(thread => thread.disposed), 'the late answer replaces them');
  assert.deepEqual(threads.filter(thread => thread.label === 'Gerrit · unresolved' && !thread.disposed).map(thread => thread.uri.path), ['/kept.c']);
  await diff.show({ key: 'other', repo: repo.directory, sha, comments: [] });
  assert.ok(threads.every(thread => thread.disposed), 'choosing another review removes the discussions');
  const failed = await diff.open({ key: 'r', repo: repo.directory, sha, title: 'T', comments: [], discussions: Promise.resolve(null) });
  assert.equal(failed.discussions, 0, 'an unreadable Gerrit leaves the diff as it was');
});
