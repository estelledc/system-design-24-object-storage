import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { generatedContent } from '../../src/contracts.js';
import { sha256 } from '../../src/crypto.js';
import { ObjectRepository } from '../../src/repository.js';
import { ObjectStorageService } from '../../src/service.js';
import { ReplicaStore } from '../../src/storage.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Infrastructure tests never skip: DATABASE_URL is required');

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const repository = new ObjectRepository(pool);
let root;
let service;

function content(pattern = 'alpha', repeat = 4, variant = 1) {
  return { pattern, repeat, variant };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

async function bucket() {
  return service.createBucket({ requestKey: 'req_bucket_001', bucket: 'lab-bucket' });
}

describe('PostgreSQL and real filesystem authority', { concurrency: false }, () => {
  before(async () => {
    await pool.query('SELECT version()');
  });

  beforeEach(async () => {
    await repository.resetSchema();
    if (root) await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), 'object-storage-integration-'));
    service = new ObjectStorageService({ repository, replicaStore: new ReplicaStore(root) });
    await service.initialize();
  });

  after(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    await pool.end();
  });

  test('PUT replay, precondition, immutable versions, list snapshot, and tombstone stay distinct', async () => {
    await bucket();
    const firstInput = {
      requestKey: 'req_put_001',
      bucket: 'lab-bucket',
      key: 'reports/day_001',
      content: content('alpha', 4, 1),
    };
    const first = await service.putObject(firstInput);
    assert.equal(first.verifiedReplicas, 3);
    assert.equal(first.evidence.readbackVerifiedReplicas, 3);
    const replay = await service.putObject(firstInput);
    assert.equal(replay.versionId, first.versionId);
    assert.equal(replay.replayed, true);
    await rejectsCode(service.putObject({ ...firstInput, content: content('alpha', 4, 2) }), 'intent_conflict');

    const snapshot = await service.createListSnapshot({
      requestKey: 'req_list_001', bucket: 'lab-bucket', prefix: 'reports/', includeTombstones: false,
    });
    assert.equal(snapshot.itemCount, 1);
    const second = await service.putObject({
      requestKey: 'req_put_002',
      bucket: 'lab-bucket',
      key: 'reports/day_001',
      content: content('beta', 4, 2),
      ifCurrentVersionId: first.versionId,
    });
    await rejectsCode(service.putObject({
      requestKey: 'req_put_003',
      bucket: 'lab-bucket',
      key: 'reports/day_001',
      content: content('gamma', 4, 3),
      ifCurrentVersionId: first.versionId,
    }), 'precondition_failed');
    const frozen = await service.getListPage({ snapshotId: snapshot.snapshotId, offset: 0, limit: 16 });
    assert.equal(frozen.items[0].versionId, first.versionId);

    const tombstone = await service.deleteObject({
      requestKey: 'req_delete_001',
      bucket: 'lab-bucket',
      key: 'reports/day_001',
      ifCurrentVersionId: second.versionId,
    });
    assert.equal(tombstone.kind, 'tombstone');
    await rejectsCode(service.readObject({ bucket: 'lab-bucket', key: 'reports/day_001' }), 'current_tombstone');
    const historical = await service.readObject({
      bucket: 'lab-bucket', key: 'reports/day_001', versionId: first.versionId, range: { start: 2, endExclusive: 10 },
    });
    assert.equal(historical.returnedByteLength, 8);
    assert.equal(historical.evidence.fullObjectDigestVerified, true);
  });

  test('multipart parts are immutable and completion is exactly-once locally', async () => {
    await bucket();
    const upload = await service.initiateMultipart({
      requestKey: 'req_upload_001', bucket: 'lab-bucket', key: 'multipart/object_001', expectedParts: 2, expiresInMs: 60_000,
    });
    const partOne = await service.putMultipartPart({
      requestKey: 'req_part_001', uploadId: upload.uploadId, partNumber: 1, content: content('alpha', 2, 1),
    });
    const equivalent = await service.putMultipartPart({
      requestKey: 'req_part_001b', uploadId: upload.uploadId, partNumber: 1, content: content('alpha', 2, 1),
    });
    assert.equal(equivalent.contentDigest, partOne.contentDigest);
    await rejectsCode(service.putMultipartPart({
      requestKey: 'req_part_changed', uploadId: upload.uploadId, partNumber: 1, content: content('beta', 2, 1),
    }), 'intent_conflict');
    await service.putMultipartPart({
      requestKey: 'req_part_002', uploadId: upload.uploadId, partNumber: 2, content: content('gamma', 2, 2),
    });
    await rejectsCode(service.completeMultipart({
      requestKey: 'req_complete_bad', uploadId: upload.uploadId, parts: [2, 1],
    }), 'parts_incomplete');
    const completed = await service.completeMultipart({
      requestKey: 'req_complete_001', uploadId: upload.uploadId, parts: [1, 2],
    });
    const scan = await service.scanOrphans({
      requestKey: 'req_multipart_scan', expectedMaintenanceGeneration: 1, minimumAgeMs: 0,
    });
    assert.equal(scan.candidateCount, 6);
    const collected = await service.garbageCollect({
      requestKey: 'req_multipart_gc', scanId: scan.scanId, expectedMaintenanceGeneration: 1, retentionMs: 0,
    });
    assert.equal(collected.deletedCount, 6);
    const partReplayAfterGc = await service.putMultipartPart({
      requestKey: 'req_part_001', uploadId: upload.uploadId, partNumber: 1, content: content('alpha', 2, 1),
    });
    assert.equal(partReplayAfterGc.replayed, true);
    const replay = await service.completeMultipart({
      requestKey: 'req_complete_001', uploadId: upload.uploadId, parts: [1, 2],
    });
    assert.equal(replay.versionId, completed.versionId);
    assert.equal(replay.replayed, true);
    const read = await service.readObject({ bucket: 'lab-bucket', key: 'multipart/object_001' });
    assert.equal(read.contentDigest, completed.contentDigest);
    await rejectsCode(service.abortMultipart({ requestKey: 'req_abort_001', uploadId: upload.uploadId }), 'upload_closed');
  });

  test('corrupt preferred copy falls back, stale repair is fenced, and current repair verifies', async () => {
    await bucket();
    const written = await service.putObject({
      requestKey: 'req_put_repair', bucket: 'lab-bucket', key: 'repair/object_001', content: content('delta', 4, 9),
    });
    await service.replicaStore.corruptForTest('node-a', written.contentDigest);
    const degraded = await service.readObject({ bucket: 'lab-bucket', key: 'repair/object_001' });
    assert.equal(degraded.evidence.degradedReplicas, 1);
    assert.equal(degraded.evidence.fullObjectDigestVerified, true);
    const firstTask = degraded.repairTaskIds[0];
    await service.advanceMaintenanceGeneration({ requestKey: 'req_repair_gen_002', kind: 'repair' });
    await rejectsCode(service.repair({
      requestKey: 'req_repair_stale', taskId: firstTask, expectedMaintenanceGeneration: 1,
    }), 'stale_generation');
    const refreshed = await service.readObject({ bucket: 'lab-bucket', key: 'repair/object_001' });
    const repaired = await service.repair({
      requestKey: 'req_repair_current', taskId: refreshed.repairTaskIds[0], expectedMaintenanceGeneration: 2,
    });
    assert.equal(repaired.readbackVerified, true);
    assert.equal((await service.replicaStore.verify('node-a', written.contentDigest)).state, 'verified');
    await service.advanceMaintenanceGeneration({ requestKey: 'req_repair_gen_003', kind: 'repair' });
    const replayAfterGenerationChange = await service.repair({
      requestKey: 'req_repair_current', taskId: refreshed.repairTaskIds[0], expectedMaintenanceGeneration: 2,
    });
    assert.equal(replayAfterGenerationChange.replayed, true);
  });

  test('below-threshold write stays invisible and expired intent becomes fenced GC work', async () => {
    await bucket();
    const oneNode = new ObjectStorageService({
      repository,
      replicaStore: new ReplicaStore(root, { nodeIds: ['node-a'] }),
      writeIntentTtlMs: 100,
    });
    const input = {
      requestKey: 'req_put_orphan', bucket: 'lab-bucket', key: 'orphan/object_001', content: content('alpha', 2, 44),
    };
    await rejectsCode(oneNode.putObject(input), 'replica_threshold_not_met');
    assert.equal(asCount(await pool.query('SELECT count(*) FROM object_versions')), 0);
    await new Promise((resolve) => setTimeout(resolve, 140));
    const scan = await service.scanOrphans({
      requestKey: 'req_scan_001', expectedMaintenanceGeneration: 1, minimumAgeMs: 0,
    });
    assert.equal(scan.candidateCount, 1);
    await service.advanceMaintenanceGeneration({ requestKey: 'req_gc_gen_002', kind: 'gc' });
    await rejectsCode(service.garbageCollect({
      requestKey: 'req_gc_stale', scanId: scan.scanId, expectedMaintenanceGeneration: 1, retentionMs: 0,
    }), 'stale_generation');
    const freshScan = await service.scanOrphans({
      requestKey: 'req_scan_002', expectedMaintenanceGeneration: 2, minimumAgeMs: 0,
    });
    const collected = await service.garbageCollect({
      requestKey: 'req_gc_002', scanId: freshScan.scanId, expectedMaintenanceGeneration: 2, retentionMs: 0,
    });
    assert.equal(collected.deletedCount, 1);
  });
});

function asCount(result) {
  return Number(result.rows[0].count);
}
