import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyOrphanEntries, pageSnapshot } from '../../src/model.js';

test('orphan classification keeps referenced and recent files', () => {
  const entries = [
    { nodeId: 'node-a', entryName: `${'a'.repeat(64)}.blob`, kind: 'blob', digest: 'a'.repeat(64), mtimeMs: 100 },
    { nodeId: 'node-b', entryName: `${'b'.repeat(64)}.blob`, kind: 'blob', digest: 'b'.repeat(64), mtimeMs: 100 },
    { nodeId: 'node-c', entryName: '.tmp-placeholder', kind: 'temporary', digest: null, mtimeMs: 950 },
  ];
  const result = classifyOrphanEntries(entries, new Set(['a'.repeat(64)]), 1_000, 100);
  assert.deepEqual(result.candidates.map((entry) => entry.digest), ['b'.repeat(64)]);
  assert.equal(result.recentCount, 1);
});

test('snapshot pages are stable values rather than live offsets', () => {
  const frozen = Object.freeze([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
  assert.deepEqual(pageSnapshot(frozen, 0, 2), { items: [{ key: 'a' }, { key: 'b' }], nextOffset: 2 });
  assert.deepEqual(pageSnapshot(frozen, 2, 2), { items: [{ key: 'c' }], nextOffset: null });
});
