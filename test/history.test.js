'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findings, summarize, title, reports } = require('../src/history');

test('finding counts use explicit markers and keep commit-message locations as an overlapping count', () => {
  const comments = ['(defect) A', '(minor) B', '(suggestion) C', '(typo) D', '**(style)** E', '(nit) F', 'There may be a defect'].map(message => ({message,file:'file.c'}));
  comments.push({file:'/COMMIT_MSG',message:'(style) Missing tag'}, {file:'/COMMIT_MSG',message:'The subject does not match the change'});
  assert.deepEqual(findings([{status:'findings',comments}], 1), {
    total:9,defect:1,minor:1,suggestion:1,typo:1,style:2,nit:1,other:2,commitMessage:2,partial:false,
  });
  assert.equal(findings([{status:'failed',comments:[]}], 1), null);
  assert.equal(findings([{status:'clean',comments:[]}], 2).partial, true);
  assert.equal(findings([{status:'clean',comments:[]}], 1).total, 0);
});

test('history keeps batch and per-commit costs, elapsed time, partial usage, unknowns and saved subjects', () => {
  const run = { commits:['aaa','bbb'],subjects:[{sha:'aaa',subject:'DDN-7062 quota: fix lockup'},{sha:'bbb',subject:'LU-2: cleanup'}],
    startedAt:'2026-10-16T10:00:00Z',finishedAt:'2026-10-16T10:00:30Z',agent:'codex',
    usage:{estimatedCostUsd:.12,costPartial:false,tokens:100,tokensPartial:false},
    results:[{sha:'aaa',status:'findings',duration:25,tokens:70,costUsd:.08,comments:[{file:'code.c',message:'(defect) Deadlock'}]},
      {sha:'bbb',status:'failed',duration:30,comments:[]}] };
  const summary = summarize(run);
  assert.equal(summary.elapsed, 30, 'batch elapsed is wall time, not a sum of concurrent jobs');
  assert.equal(summary.cost, .12);
  assert.equal(summary.costLabel, 'API estimate');
  assert.equal(summary.tokenPartial, false);
  assert.equal(summary.findings.partial, true);
  assert.equal(summary.commits[0].elapsed, 25);
  assert.equal(summary.commits[0].tokens, 70);
  assert.equal(summary.commits[1].tokens, null);
  assert.equal(summary.commits[1].findings, null);
  assert.equal(title(run), 'DDN-7062 quota: fix lockup / LU-2: cleanup');
  assert.equal(title({commits:['aaa'],results:[{sha:'aaa',subject:'Old report title'}]}), 'Old report title');
  assert.equal(summarize({commits:['aaa'],results:[]}).elapsed, null);
  assert.equal(summarize({commits:['aaa'],results:[]}).tokens, null);
  const partial = summarize({...run,usage:{}});
  assert.equal(partial.tokens, 70);
  assert.equal(partial.tokenPartial, true);
});

test('batch history contains isolated patch reports without copying aggregate usage to each commit', () => {
  const run = {id:'batch',commits:['aaa','bbb'],status:'failed',model:'opus',effort:'max',mode:'light',
    startedAt:'2026-10-16T10:00:00Z',finishedAt:'2026-10-16T10:01:00Z',
    usage:{tokens:1000,costUsd:12,byCommit:{aaa:{tokens:100,estimatedCostUsd:.12,tokensPartial:false,costPartial:false}}},
    results:[{sha:'aaa',subject:'LU-1: first',status:'clean',duration:12,comments:[]},
      {sha:'bbb',subject:'LU-2: second',status:'failed',error:'Failure',comments:[]}]};
  const [first, second] = reports(run);
  assert.equal(first.id, 'batch:aaa');
  assert.equal(first.runId, 'batch');
  assert.equal(first.reportSha, 'aaa');
  assert.equal(first.status, 'completed');
  assert.equal(first.effort, 'max');
  assert.equal(first.mode, 'light');
  assert.deepEqual(first.commits, ['aaa']);
  assert.equal(summarize(first).elapsed, 12);
  assert.equal(summarize(first).tokens, 100);
  assert.equal(summarize(first).cost, .12);
  assert.equal(second.status, 'failed');
  assert.equal(summarize(second).tokens, null);
  assert.equal(summarize(second).cost, null);
  assert.equal(summarize(second).elapsed, null);
  assert.equal(reports({...run,commits:['aaa']})[0].id, 'batch', 'single-report IDs remain compatible');
  assert.equal(reports({...run,commits:['aaa']})[0].status, 'failed', 'a failed single run must not look clean');
  const globalFailure = reports({...run,error:'Worker exited unexpectedly',results:run.results.slice(0,1)});
  assert.equal(globalFailure[0].status, 'failed');
  assert.equal(globalFailure[0].error, 'Worker exited unexpectedly');
});
