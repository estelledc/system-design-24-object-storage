import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createRuntime } from './runtime.mjs';

const fixture = Object.freeze({
  objects: 64,
  objectBytes: 16_384,
  fullReads: 64,
  rangeReads: 64,
  multipartParts: 4,
  multipartPartBytes: 16_384,
  listSnapshots: 16,
});

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'object-storage-benchmark-'));
  const runtime = await createRuntime({ storageRoot: root, reset: true });
  try {
    const postgresVersion = (await runtime.pool.query('SHOW server_version')).rows[0].server_version;
    await runtime.service.createBucket({ requestKey: 'req_bench_bucket', bucket: 'bench-bucket' });
    const patterns = ['alpha', 'beta', 'gamma', 'delta'];
    const versions = [];

    const putStarted = process.hrtime.bigint();
    for (let index = 0; index < fixture.objects; index += 1) {
      versions.push(await runtime.service.putObject({
        requestKey: `req_bench_put_${String(index).padStart(3, '0')}`,
        bucket: 'bench-bucket',
        key: `objects/item_${String(index).padStart(3, '0')}`,
        content: { pattern: patterns[index % patterns.length], repeat: 1_024, variant: index },
      }));
    }
    const putElapsedMs = elapsedMs(putStarted);
    assert.ok(versions.every((version) => version.byteLength === fixture.objectBytes));

    const fullReadStarted = process.hrtime.bigint();
    for (let index = 0; index < fixture.fullReads; index += 1) {
      const read = await runtime.service.readObject({
        bucket: 'bench-bucket', key: `objects/item_${String(index).padStart(3, '0')}`,
      });
      assert.equal(read.returnedByteLength, fixture.objectBytes);
    }
    const fullReadElapsedMs = elapsedMs(fullReadStarted);

    const rangeReadStarted = process.hrtime.bigint();
    for (let index = 0; index < fixture.rangeReads; index += 1) {
      const read = await runtime.service.readObject({
        bucket: 'bench-bucket',
        key: `objects/item_${String(index).padStart(3, '0')}`,
        range: { start: 4_096, endExclusive: 8_192 },
      });
      assert.equal(read.returnedByteLength, 4_096);
      assert.equal(read.evidence.fullObjectDigestVerified, true);
    }
    const rangeReadElapsedMs = elapsedMs(rangeReadStarted);

    const multipartStarted = process.hrtime.bigint();
    const upload = await runtime.service.initiateMultipart({
      requestKey: 'req_bench_upload',
      bucket: 'bench-bucket',
      key: 'objects/multipart',
      expectedParts: fixture.multipartParts,
      expiresInMs: 60_000,
    });
    for (let number = 1; number <= fixture.multipartParts; number += 1) {
      const part = await runtime.service.putMultipartPart({
        requestKey: `req_bench_part_${number}`,
        uploadId: upload.uploadId,
        partNumber: number,
        content: { pattern: patterns[number - 1], repeat: 1_024, variant: 1_000 + number },
      });
      assert.equal(part.byteLength, fixture.multipartPartBytes);
    }
    const multipart = await runtime.service.completeMultipart({
      requestKey: 'req_bench_complete', uploadId: upload.uploadId, parts: [1, 2, 3, 4],
    });
    assert.equal(multipart.byteLength, 65_536);
    const multipartElapsedMs = elapsedMs(multipartStarted);

    const listStarted = process.hrtime.bigint();
    let listedItems = 0;
    for (let index = 0; index < fixture.listSnapshots; index += 1) {
      const snapshot = await runtime.service.createListSnapshot({
        requestKey: `req_bench_list_${String(index).padStart(2, '0')}`,
        bucket: 'bench-bucket',
        prefix: 'objects/',
        includeTombstones: false,
      });
      const page = await runtime.service.getListPage({ snapshotId: snapshot.snapshotId, offset: 0, limit: 32 });
      listedItems += page.items.length;
    }
    const listElapsedMs = elapsedMs(listStarted);

    await runtime.replicaStore.corruptForTest('node-a', versions[0].contentDigest);
    const degraded = await runtime.service.readObject({ bucket: 'bench-bucket', key: 'objects/item_000' });
    const repairStarted = process.hrtime.bigint();
    await runtime.service.repair({
      requestKey: 'req_bench_repair', taskId: degraded.repairTaskIds[0], expectedMaintenanceGeneration: 1,
    });
    const repairElapsedMs = elapsedMs(repairStarted);

    const oneNodeRuntime = await createRuntime({ storageRoot: root, nodeIds: ['node-a'], writeIntentTtlMs: 100 });
    try {
      await assert.rejects(
        oneNodeRuntime.service.putObject({
          requestKey: 'req_bench_orphan',
          bucket: 'bench-bucket',
          key: 'objects/orphan',
          content: { pattern: 'alpha', repeat: 2, variant: 2_000 },
        }),
        (error) => error?.code === 'replica_threshold_not_met',
      );
    } finally {
      await oneNodeRuntime.pool.end();
    }
    await new Promise((resolve) => setTimeout(resolve, 140));
    const scan = await runtime.service.scanOrphans({
      requestKey: 'req_bench_scan', expectedMaintenanceGeneration: 1, minimumAgeMs: 0,
    });
    const gc = await runtime.service.garbageCollect({
      requestKey: 'req_bench_gc', scanId: scan.scanId, expectedMaintenanceGeneration: 1, retentionMs: 0,
    });

    const files = await runtime.replicaStore.listEntries();
    const state = await runtime.service.state();
    assert.equal(state.invariantViolations, 0);
    const physicalBytesAfterGc = files.reduce((total, entry) => total + entry.byteLength, 0);

    process.stdout.write(`${JSON.stringify({
      evidence: 'bounded_object_storage_benchmark',
      fixture,
      observations: {
        logicalObjectBytes: fixture.objects * fixture.objectBytes,
        multipartCompletedBytes: multipart.byteLength,
        sameHostBlobFilesAfterGc: files.filter((entry) => entry.kind === 'blob').length,
        physicalBytesAfterGc,
        listPageItemsObserved: listedItems,
        degradedReplicasObserved: degraded.evidence.degradedReplicas,
        orphanCandidatesObserved: scan.candidateCount,
        orphanFilesDeleted: gc.deletedCount,
        putElapsedMs,
        fullReadElapsedMs,
        rangeReadElapsedMs,
        multipartElapsedMs,
        listElapsedMs,
        repairElapsedMs,
      },
      runtime: {
        node: process.version,
        postgresql: postgresVersion,
        platform: process.platform,
        arch: process.arch,
      },
      exclusions: {
        sameHostOnly: true,
        s3CompatibilityProved: false,
        durabilityPercentageProved: false,
        availabilitySlaProved: false,
        productionCapacityProved: false,
        backupRestoreProved: false,
        externalAcceptanceProved: false,
      },
    })}\n`);
  } finally {
    await runtime.pool.end();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : 'benchmark failed'}\n`);
  process.exitCode = 1;
});
