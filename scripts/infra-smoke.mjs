import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObjectHttpServer } from '../src/http.js';
import { createRuntime } from './runtime.mjs';

const token = process.env.OBJECT_API_TOKEN;
if (!token) throw new Error('OBJECT_API_TOKEN is required');

function crashProcess({ action, input, root, boundary, ttlMs = 300_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/crash-worker.mjs', action], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        OBJECT_STORAGE_ROOT: root,
        OBJECT_CRASH_INPUT: JSON.stringify(input),
        OBJECT_WRITE_INTENT_TTL_MS: String(ttlMs),
        [boundary]: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
}

async function expectKilled(options, killedProcesses) {
  const outcome = await crashProcess(options);
  assert.equal(outcome.signal, 'SIGKILL', `expected SIGKILL, got code=${outcome.code}, stderr=${outcome.stderr}`);
  killedProcesses.push(options.boundary);
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'object-storage-smoke-'));
  const logs = [];
  const runtime = await createRuntime({ storageRoot: root, reset: true, logger: (event) => logs.push(event) });
  const killedProcesses = [];
  let server;
  try {
    await runtime.service.createBucket({ requestKey: 'req_smoke_bucket', bucket: 'smoke-bucket' });

    const firstReplicaInput = {
      requestKey: 'req_smoke_first_replica',
      bucket: 'smoke-bucket',
      key: 'crash/first_replica',
      content: { pattern: 'alpha', repeat: 8, variant: 1 },
    };
    await expectKilled({
      action: 'put', input: firstReplicaInput, root, boundary: 'OBJECT_CRASH_AFTER_FIRST_REPLICA',
    }, killedProcesses);
    assert.equal(Number((await runtime.pool.query('SELECT count(*) FROM object_versions')).rows[0].count), 0);
    const recoveredFirst = await runtime.service.putObject(firstReplicaInput);
    assert.equal(recoveredFirst.evidence.adoptedReplicas, 1);

    const orphanInput = {
      requestKey: 'req_smoke_orphan',
      bucket: 'smoke-bucket',
      key: 'crash/orphan',
      content: { pattern: 'beta', repeat: 8, variant: 2 },
    };
    await expectKilled({
      action: 'put', input: orphanInput, root, boundary: 'OBJECT_CRASH_AFTER_FIRST_REPLICA', ttlMs: 100,
    }, killedProcesses);
    await new Promise((resolve) => setTimeout(resolve, 140));
    const orphanScan = await runtime.service.scanOrphans({
      requestKey: 'req_smoke_orphan_scan', expectedMaintenanceGeneration: 1, minimumAgeMs: 0,
    });
    assert.equal(orphanScan.candidateCount, 1);
    const orphanGc = await runtime.service.garbageCollect({
      requestKey: 'req_smoke_orphan_gc', scanId: orphanScan.scanId, expectedMaintenanceGeneration: 1, retentionMs: 0,
    });
    assert.equal(orphanGc.deletedCount, 1);

    const putCommitInput = {
      requestKey: 'req_smoke_put_commit',
      bucket: 'smoke-bucket',
      key: 'crash/put_commit',
      content: { pattern: 'gamma', repeat: 8, variant: 3 },
    };
    await expectKilled({
      action: 'put', input: putCommitInput, root, boundary: 'OBJECT_CRASH_AFTER_PUT_COMMIT',
    }, killedProcesses);
    const putReplay = await runtime.service.putObject(putCommitInput);
    assert.equal(putReplay.replayed, true);
    assert.equal(Number((await runtime.pool.query(
      "SELECT count(*) FROM object_versions WHERE object_key = 'crash/put_commit'",
    )).rows[0].count), 1);

    const upload = await runtime.service.initiateMultipart({
      requestKey: 'req_smoke_upload', bucket: 'smoke-bucket', key: 'crash/multipart', expectedParts: 2, expiresInMs: 60_000,
    });
    const partOneInput = {
      requestKey: 'req_smoke_part_one',
      uploadId: upload.uploadId,
      partNumber: 1,
      content: { pattern: 'alpha', repeat: 4, variant: 11 },
    };
    await expectKilled({
      action: 'part', input: partOneInput, root, boundary: 'OBJECT_CRASH_AFTER_PART_COMMIT',
    }, killedProcesses);
    assert.equal((await runtime.service.putMultipartPart(partOneInput)).replayed, true);
    await runtime.service.putMultipartPart({
      requestKey: 'req_smoke_part_two',
      uploadId: upload.uploadId,
      partNumber: 2,
      content: { pattern: 'delta', repeat: 4, variant: 12 },
    });
    const completionInput = { requestKey: 'req_smoke_complete', uploadId: upload.uploadId, parts: [1, 2] };
    await expectKilled({
      action: 'complete', input: completionInput, root, boundary: 'OBJECT_CRASH_AFTER_COMPLETE_COMMIT',
    }, killedProcesses);
    const completionReplay = await runtime.service.completeMultipart(completionInput);
    assert.equal(completionReplay.replayed, true);

    const deleteInput = {
      requestKey: 'req_smoke_delete',
      bucket: 'smoke-bucket',
      key: 'crash/multipart',
      ifCurrentVersionId: completionReplay.versionId,
    };
    await expectKilled({
      action: 'delete', input: deleteInput, root, boundary: 'OBJECT_CRASH_AFTER_DELETE_COMMIT',
    }, killedProcesses);
    assert.equal((await runtime.service.deleteObject(deleteInput)).replayed, true);
    await assert.rejects(
      runtime.service.readObject({ bucket: 'smoke-bucket', key: 'crash/multipart' }),
      (error) => error?.code === 'current_tombstone',
    );

    await runtime.replicaStore.corruptForTest('node-a', putReplay.contentDigest);
    const degraded = await runtime.service.readObject({ bucket: 'smoke-bucket', key: 'crash/put_commit' });
    assert.equal(degraded.evidence.degradedReplicas, 1);
    const repaired = await runtime.service.repair({
      requestKey: 'req_smoke_repair', taskId: degraded.repairTaskIds[0], expectedMaintenanceGeneration: 1,
    });
    assert.equal(repaired.readbackVerified, true);

    const snapshot = await runtime.service.createListSnapshot({
      requestKey: 'req_smoke_list', bucket: 'smoke-bucket', prefix: 'crash/', includeTombstones: true,
    });
    const page = await runtime.service.getListPage({ snapshotId: snapshot.snapshotId, offset: 0, limit: 16 });
    assert.equal(page.materialized, true);

    server = createObjectHttpServer({ service: runtime.service, apiToken: token, logger: (event) => logs.push(event) });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const stateResponse = await fetch(`http://127.0.0.1:${address.port}/v1/state`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.equal(state.invariantViolations, 0);
    assert.equal(state.backupRestoreProved, false);
    assert.equal(state.externalAcceptanceProved, false);
    const serializedLogs = JSON.stringify(logs);
    assert.doesNotMatch(serializedLogs, /smoke-bucket|req_smoke|crash\/|[a-f0-9]{64}|synthetic-token/);

    assert.equal(killedProcesses.length, 6);
    process.stdout.write(`${JSON.stringify({
      evidence: 'object_storage_infra_smoke',
      killedProcesses,
      sameHostOnly: true,
      verifiedReadAfterCorruption: degraded.evidence.fullObjectDigestVerified,
      repairedReplicaReadback: repaired.readbackVerified,
      orphanFilesDeleted: orphanGc.deletedCount,
      listSnapshotMaterialized: page.materialized,
      invariantViolations: state.invariantViolations,
      s3CompatibilityProved: false,
      durabilityPercentageProved: false,
      backupRestoreProved: false,
      externalAcceptanceProved: false,
    })}\n`);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await runtime.pool.end();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : 'smoke failed'}\n`);
  process.exitCode = 1;
});
