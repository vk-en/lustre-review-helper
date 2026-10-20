'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { gerritTarget, summaryEntry } = require('../src/review-targets');

test('Gerrit execution targets retain patchset pins and refuse incomplete or unsafe metadata', () => {
  const patch={number:64086,patchset:2,project:'fs/lustre-release',url:'https://review.whamcloud.com/64086/2',revision:'a'.repeat(40)};
  const target=gerritTarget(patch);
  assert.equal(target.url,'https://review.whamcloud.com/c/fs/lustre-release/+/64086/2');
  assert.equal(target.owner,undefined);
  assert.equal(gerritTarget({...patch,owner:'  Test Author '}).owner,'Test Author');
  assert.equal(gerritTarget({...patch,owner:{name:'Test Author'}}).owner,undefined);
  assert.equal(gerritTarget({...patch,branch:' b_es6_0 '}).branch,'b_es6_0');
  assert.equal(gerritTarget({...patch,branch:'bad\nbranch'}).branch,undefined);
  for (const update of [{project:''},{project:'../other'},{project:'fs/../../other'},{number:64087},{patchset:3},
    {url:'https://review.whamcloud.com/64086'},{url:'https://evil.test/64086/2'}]) {
    assert.throws(()=>gerritTarget({...patch,...update}));
  }
  const matching={local:false,number:64086,patchset:2,sha:'a'.repeat(40),repository:'fs/lustre-release'};
  const summary={wrongPatchset:{...matching,patchset:3},wrongSha:{...matching,sha:'b'.repeat(40)},
    local:{...matching,local:true},otherProject:{...matching,repository:'other/project'}};
  assert.equal(summaryEntry(summary,target.id,[target]),undefined);
  summary.correct=matching;
  assert.equal(summaryEntry(summary,target.id,[target]),matching);
});
