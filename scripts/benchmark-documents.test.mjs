import assert from 'node:assert/strict';
import { test } from 'node:test';
import { realisticTopic, workloadDigest, responseDigest, percentile } from './benchmark-workload.mjs';

test('realistic workload is deterministic, varied, and has only earlier parent references', () => {
  const digest = workloadDigest('acceptance-v1', 10000);
  assert.deepEqual(digest, workloadDigest('acceptance-v1', 10000));
  assert.notEqual(digest.sha256, workloadDigest('other-seed', 10000).sha256);
  assert.equal(Object.values(digest.bodyHistogram).reduce((sum, n) => sum + n, 0), 10000);
  assert.ok(Object.keys(digest.bodyHistogram).length === 4 && digest.bodyHistogram[36000] > 0);
  assert.ok(digest.parentEdges > 10000 && digest.membershipEdges > 0 && digest.closedTopics > 0);
  let unicode = false, multipleParents = false, unplaced = false;
  for (let i = 0; i < 10000; i++) {
    const topic = realisticTopic('acceptance-v1', i);
    assert.ok(topic.parentIndexes.every(parent => parent < i));
    assert.equal(topic.body.length, topic.bodyUnits);
    assert.ok(topic.body.includes(topic.reference));
    unicode ||= /[^\x00-\x7F]/.test(topic.body);
    multipleParents ||= topic.parentIndexes.length > 1;
    unplaced ||= topic.workstreamIndexes.length === 0;
  }
  assert.ok(unicode && multipleParents && unplaced);
});

test('control comparison ignores timings but not ranking, eligibility or versions', () => {
  const a = { results: [{ id: 'a', resourceVersion: 7 }, { id: 'b', evidence: 'both' }], timings: { rankingMs: 100 } };
  assert.deepEqual(responseDigest(a), responseDigest({ ...a, timings: { rankingMs: 20 } }));
  assert.notDeepEqual(responseDigest(a), responseDigest({ ...a, results: [...a.results].reverse() }));
  assert.notDeepEqual(responseDigest(a), responseDigest({ ...a, results: [{ id: 'a', resourceVersion: 8 }] }));
  assert.equal(percentile([1, 2, 3, 4, 100], .95), 100);
});
