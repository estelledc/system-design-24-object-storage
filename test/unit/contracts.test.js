import assert from 'node:assert/strict';
import test from 'node:test';
import {
  byteRange,
  generatedContent,
  objectKey,
  partSequence,
  requestKey,
} from '../../src/contracts.js';
import { canonicalJson, digestObject, sha256 } from '../../src/crypto.js';

test('generated content is bounded, exact, and variant-sensitive', () => {
  const first = generatedContent({ pattern: 'alpha', repeat: 1_024, variant: 7 });
  const replay = generatedContent({ variant: 7, repeat: 1_024, pattern: 'alpha' });
  const changed = generatedContent({ pattern: 'alpha', repeat: 1_024, variant: 8 });
  assert.equal(first.bytes.length, 16_384);
  assert.equal(sha256(first.bytes), sha256(replay.bytes));
  assert.notEqual(sha256(first.bytes), sha256(changed.bytes));
  assert.deepEqual(first.spec, { pattern: 'alpha', repeat: 1_024, variant: 7 });
});

test('canonical JSON and intent digest ignore object key insertion order', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), canonicalJson({ a: { x: 3, y: 2 }, z: 1 }));
  assert.equal(digestObject({ request: 'one', bytes: 16 }), digestObject({ bytes: 16, request: 'one' }));
});

test('keys and request identities reject traversal, ambiguity, and unknown fields', () => {
  assert.equal(objectKey('reports/day_001'), 'reports/day_001');
  assert.equal(requestKey('req_put_001'), 'req_put_001');
  for (const key of ['../secret', 'a//b', 'a/./b', 'a/../b', '/absolute', 'a\\b']) {
    assert.throws(() => objectKey(key), { code: 'invalid_input' });
  }
  assert.throws(() => generatedContent({ pattern: 'alpha', repeat: 1, bytes: 16 }), { code: 'invalid_input' });
  assert.throws(() => generatedContent({ pattern: 'alpha', repeat: 4_097 }), { code: 'invalid_input' });
});

test('range and multipart order are explicit and bounded', () => {
  assert.deepEqual(byteRange({ start: 3, endExclusive: 9 }, 16), { start: 3, endExclusive: 9 });
  assert.throws(() => byteRange({ start: 9, endExclusive: 9 }, 16), { code: 'invalid_input' });
  assert.deepEqual(partSequence([1, 2, 3], 3), [1, 2, 3]);
  assert.throws(() => partSequence([2, 1], 2), { code: 'parts_incomplete' });
});
