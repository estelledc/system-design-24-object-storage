import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sha256 } from '../../src/crypto.js';
import { ReplicaStore } from '../../src/storage.js';

test('replica publication distinguishes first write, adoption, corruption, and repair', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'object-storage-unit-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReplicaStore(root);
  const bytes = Buffer.from('bounded-synthetic-object');
  const digest = sha256(bytes);

  const first = await store.publish('node-a', bytes, digest);
  assert.deepEqual(
    {
      adopted: first.adopted,
      fileSynced: first.fileSynced,
      directorySynced: first.directorySynced,
      readbackVerified: first.readbackVerified,
    },
    { adopted: false, fileSynced: true, directorySynced: true, readbackVerified: true },
  );
  const replay = await store.publish('node-a', bytes, digest);
  assert.equal(replay.adopted, true);
  await store.corruptForTest('node-a', digest);
  assert.equal((await store.verify('node-a', digest)).state, 'corrupt');
  const repaired = await store.publish('node-a', bytes, digest);
  assert.equal(repaired.adopted, false);
  assert.equal((await store.verify('node-a', digest)).state, 'verified');
});
