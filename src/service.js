import {
  MAX_BYTES,
  MAX_LIST_ITEMS,
  NODE_IDS,
  PLACEMENT_GENERATION,
  REQUIRED_REPLICAS,
  bucketName,
  byteRange,
  currentVersionPrecondition,
  entityId,
  exactKeys,
  expectedParts,
  expiryMs,
  generatedContent,
  generation,
  includeTombstones,
  minimumAgeMs,
  objectKey,
  pageLimit,
  pageOffset,
  partNumber,
  partSequence,
  requestKey,
  scanId,
  snapshotId,
  taskId,
  uploadId,
  versionId,
} from './contracts.js';
import { deterministicId, digestObject, sha256 } from './crypto.js';
import { assertInvariant, fail } from './errors.js';
import { classifyOrphanEntries, pageSnapshot } from './model.js';

const DEFAULT_PRINCIPAL = 'synthetic-principal';

function asNumber(value) {
  return Number(value);
}

function killAt(boundary) {
  if (process.env[boundary] === '1') process.kill(process.pid, 'SIGKILL');
}

function nowMs() {
  return Date.now();
}

export class ObjectStorageService {
  constructor({
    repository,
    replicaStore,
    principal = DEFAULT_PRINCIPAL,
    logger = () => {},
    writeIntentTtlMs = Number(process.env.OBJECT_WRITE_INTENT_TTL_MS ?? 300_000),
  }) {
    this.repository = repository;
    this.replicaStore = replicaStore;
    this.principal = principal;
    this.logger = logger;
    this.writeIntentTtlMs = writeIntentTtlMs;
  }

  async initialize() {
    await this.replicaStore.initialize();
  }

  async createBucket(input) {
    exactKeys(input, ['requestKey', 'bucket']);
    const request = requestKey(input.requestKey);
    const bucket = bucketName(input.bucket);
    const operation = 'create_bucket';
    const intentDigest = digestObject({ operation, bucket });

    const result = await this.repository.withMutation({
      principal: this.principal,
      requestKey: request,
      operation,
      intentDigest,
      callback: async (client) => {
        const existing = await client.query(
          'SELECT 1 FROM buckets WHERE principal = $1 AND bucket_name = $2',
          [this.principal, bucket],
        );
        if (existing.rowCount > 0) fail('intent_conflict', 'bucket already exists under another request', 409);
        await client.query(
          'INSERT INTO buckets (principal, bucket_name) VALUES ($1, $2)',
          [this.principal, bucket],
        );
        return { bucket, metadataCommitted: true, replayed: false };
      },
    });
    this.logger({ event: 'bucket_create', outcome: 'committed', replayed: result.replayed });
    return result;
  }

  async prepareReplicas(bytes, contentDigest, crashBoundary = null) {
    const receipts = [];
    let failures = 0;
    for (const nodeId of this.replicaStore.nodeIds) {
      try {
        receipts.push(await this.replicaStore.publish(nodeId, bytes, contentDigest));
        if (receipts.length === 1 && crashBoundary) killAt(crashBoundary);
      } catch {
        failures += 1;
      }
    }
    if (receipts.length < REQUIRED_REPLICAS) {
      fail('replica_threshold_not_met', 'verified replica threshold was not met', 503);
    }
    return { receipts, failures };
  }

  async requireBucket(client, bucket) {
    const result = await client.query(
      'SELECT 1 FROM buckets WHERE principal = $1 AND bucket_name = $2',
      [this.principal, bucket],
    );
    if (result.rowCount === 0) fail('not_found', 'bucket was not found', 404);
  }

  async lockKey(client, bucket, key) {
    await this.repository.lock(client, `key:${this.principal}:${bucket}:${key}`);
  }

  async currentHead(client, bucket, key) {
    const result = await client.query(
      `SELECT h.version_id, h.head_generation, v.kind
         FROM object_heads h
         JOIN object_versions v
           ON v.principal = h.principal
          AND v.bucket_name = h.bucket_name
          AND v.object_key = h.object_key
          AND v.version_id = h.version_id
        WHERE h.principal = $1 AND h.bucket_name = $2 AND h.object_key = $3`,
      [this.principal, bucket, key],
    );
    return result.rows[0] ?? null;
  }

  assertPrecondition(precondition, current) {
    if (precondition === null) return;
    if (precondition === 'absent' && current === null) return;
    if (current && precondition === current.version_id) return;
    fail('precondition_failed', 'current version precondition did not match', 409);
  }

  async recordReplicaRows(client, contentDigest, byteLength, receipts) {
    const byNode = new Map(receipts.map((receipt) => [receipt.nodeId, receipt]));
    for (const nodeId of NODE_IDS) {
      const receipt = byNode.get(nodeId);
      if (receipt) {
        await client.query(
          `INSERT INTO replicas
             (content_digest, node_id, placement_generation, byte_length, state, receipt_digest, verified_at)
           VALUES ($1, $2, $3, $4, 'verified', $5, statement_timestamp())
           ON CONFLICT (content_digest, node_id, placement_generation) DO UPDATE
             SET byte_length = EXCLUDED.byte_length,
                 state = 'verified',
                 receipt_digest = EXCLUDED.receipt_digest,
                 verified_at = EXCLUDED.verified_at,
                 updated_at = statement_timestamp()`,
          [contentDigest, nodeId, PLACEMENT_GENERATION, byteLength, receipt.receiptDigest],
        );
      } else {
        await client.query(
          `INSERT INTO replicas
             (content_digest, node_id, placement_generation, byte_length, state)
           VALUES ($1, $2, $3, $4, 'missing')
           ON CONFLICT (content_digest, node_id, placement_generation) DO NOTHING`,
          [contentDigest, nodeId, PLACEMENT_GENERATION, byteLength],
        );
      }
    }
  }

  async insertDataVersion(client, {
    bucket,
    key,
    version,
    contentDigest,
    byteLength,
    receipts,
    precondition,
  }) {
    await this.requireBucket(client, bucket);
    await this.lockKey(client, bucket, key);
    const current = await this.currentHead(client, bucket, key);
    this.assertPrecondition(precondition, current);
    await this.repository.lockGcReferences(client, 'SHARE');
    await this.recordReplicaRows(client, contentDigest, byteLength, receipts);

    const manifestDigest = digestObject({
      version,
      contentDigest,
      byteLength,
      placementGeneration: PLACEMENT_GENERATION,
      requiredReplicas: REQUIRED_REPLICAS,
      nodes: NODE_IDS,
    });
    const inserted = await client.query(
      `INSERT INTO object_versions
         (principal, bucket_name, object_key, version_id, kind, content_digest, byte_length,
          placement_generation, required_replicas, result_digest)
       VALUES ($1, $2, $3, $4, 'data', $5, $6, $7, $8, $9)
       RETURNING version_sequence`,
      [
        this.principal,
        bucket,
        key,
        version,
        contentDigest,
        byteLength,
        PLACEMENT_GENERATION,
        REQUIRED_REPLICAS,
        manifestDigest,
      ],
    );
    for (const nodeId of NODE_IDS) {
      await client.query(
        `INSERT INTO version_replicas
           (principal, bucket_name, object_key, version_id, content_digest, node_id, placement_generation)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [this.principal, bucket, key, version, contentDigest, nodeId, PLACEMENT_GENERATION],
      );
    }
    await client.query(
      `INSERT INTO object_heads (principal, bucket_name, object_key, version_id, head_generation)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (principal, bucket_name, object_key) DO UPDATE
         SET version_id = EXCLUDED.version_id,
             head_generation = object_heads.head_generation + 1,
             updated_at = statement_timestamp()`,
      [this.principal, bucket, key, version],
    );

    return {
      versionId: version,
      versionSequence: asNumber(inserted.rows[0].version_sequence),
      kind: 'data',
      contentDigest,
      byteLength,
      placementGeneration: PLACEMENT_GENERATION,
      verifiedReplicas: receipts.length,
      requiredReplicas: REQUIRED_REPLICAS,
      evidence: {
        fileSyncedReplicas: receipts.filter((receipt) => receipt.fileSynced).length,
        directorySyncedReplicas: receipts.filter((receipt) => receipt.directorySynced).length,
        readbackVerifiedReplicas: receipts.filter((receipt) => receipt.readbackVerified).length,
        adoptedReplicas: receipts.filter((receipt) => receipt.adopted).length,
        sameHostOnly: true,
        metadataCommitted: true,
        backupRestoreProved: false,
        externalAcceptanceProved: false,
      },
      replayed: false,
    };
  }

  async putObject(input) {
    exactKeys(input, ['requestKey', 'bucket', 'key', 'content', 'ifCurrentVersionId'], ['requestKey', 'bucket', 'key', 'content']);
    const request = requestKey(input.requestKey);
    const bucket = bucketName(input.bucket);
    const key = objectKey(input.key);
    const precondition = currentVersionPrecondition(input.ifCurrentVersionId);
    const { spec, bytes } = generatedContent(input.content);
    const contentDigest = sha256(bytes);
    const operation = 'put_object';
    const intent = { operation, bucket, key, content: spec, contentDigest, byteLength: bytes.length, precondition };
    const intentDigest = digestObject(intent);
    const version = deterministicId('ver', { principal: this.principal, request, intentDigest });

    const reservation = await this.repository.reserveWriteIntent({
      principal: this.principal,
      requestKey: request,
      operation,
      intentDigest,
      contentDigest,
      byteLength: bytes.length,
      ttlMs: this.writeIntentTtlMs,
    });
    if (reservation.replay) return reservation.replay;

    const { receipts, failures } = await this.prepareReplicas(bytes, contentDigest, 'OBJECT_CRASH_AFTER_FIRST_REPLICA');
    const result = await this.repository.withMutation({
      principal: this.principal,
      requestKey: request,
      operation,
      intentDigest,
      callback: async (client) => {
        await this.repository.assertWriteIntent(client, this.principal, request, operation, intentDigest, contentDigest);
        const committed = await this.insertDataVersion(client, {
          bucket,
          key,
          version,
          contentDigest,
          byteLength: bytes.length,
          receipts,
          precondition,
        });
        await this.repository.clearWriteIntent(client, this.principal, request, operation);
        return committed;
      },
    });
    killAt('OBJECT_CRASH_AFTER_PUT_COMMIT');
    this.logger({ event: 'object_put', outcome: 'committed', verifiedReplicas: result.verifiedReplicas, failures });
    return result;
  }

  async loadVersion(bucket, key, requestedVersion) {
    const values = [this.principal, bucket, key];
    const sql = requestedVersion
      ? `SELECT v.*
           FROM object_versions v
          WHERE v.principal = $1 AND v.bucket_name = $2 AND v.object_key = $3 AND v.version_id = $4`
      : `SELECT v.*
           FROM object_heads h
           JOIN object_versions v
             ON v.principal = h.principal
            AND v.bucket_name = h.bucket_name
            AND v.object_key = h.object_key
            AND v.version_id = h.version_id
          WHERE h.principal = $1 AND h.bucket_name = $2 AND h.object_key = $3`;
    if (requestedVersion) values.push(requestedVersion);
    const result = await this.repository.pool.query(sql, values);
    if (result.rowCount === 0) fail('not_found', 'object version was not found', 404);
    if (result.rows[0].kind === 'tombstone') fail('current_tombstone', 'selected version is a tombstone', 404);
    return result.rows[0];
  }

  async recordReplicaIssues(version, issues) {
    if (issues.length === 0) return [];
    return this.repository.transaction(async (client) => {
      const generationResult = await client.query(
        "SELECT generation FROM maintenance_generations WHERE kind = 'repair'",
      );
      const maintenanceGeneration = asNumber(generationResult.rows[0].generation);
      const tasks = [];
      for (const issue of issues) {
        await client.query(
          `UPDATE replicas
              SET state = $4, receipt_digest = NULL, verified_at = NULL, updated_at = statement_timestamp()
            WHERE content_digest = $1 AND node_id = $2 AND placement_generation = $3`,
          [version.content_digest, issue.nodeId, asNumber(version.placement_generation), issue.state],
        );
        const id = deterministicId('rpr', {
          principal: this.principal,
          version: version.version_id,
          node: issue.nodeId,
          maintenanceGeneration,
        });
        await client.query(
          `INSERT INTO repair_tasks
             (principal, task_id, bucket_name, object_key, version_id, content_digest, target_node_id,
              placement_generation, maintenance_generation, observed_state, state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
           ON CONFLICT (principal, task_id) DO UPDATE
             SET observed_state = EXCLUDED.observed_state,
                 updated_at = statement_timestamp()`,
          [
            this.principal,
            id,
            version.bucket_name,
            version.object_key,
            version.version_id,
            version.content_digest,
            issue.nodeId,
            asNumber(version.placement_generation),
            maintenanceGeneration,
            issue.state,
          ],
        );
        tasks.push(id);
      }
      return tasks;
    });
  }

  async readObject(input) {
    exactKeys(input, ['bucket', 'key', 'versionId', 'range'], ['bucket', 'key']);
    const bucket = bucketName(input.bucket);
    const key = objectKey(input.key);
    const requestedVersion = versionId(input.versionId);
    const version = await this.loadVersion(bucket, key, requestedVersion);
    const replicaRows = await this.repository.pool.query(
      `SELECT vr.node_id
         FROM version_replicas vr
        WHERE vr.principal = $1 AND vr.bucket_name = $2 AND vr.object_key = $3 AND vr.version_id = $4
        ORDER BY vr.node_id`,
      [this.principal, bucket, key, version.version_id],
    );

    const issues = [];
    let source = null;
    for (const row of replicaRows.rows) {
      const candidate = await this.replicaStore.verify(row.node_id, version.content_digest, { includeBytes: true });
      if (candidate.state === 'verified' && candidate.byteLength === asNumber(version.byte_length)) {
        source ??= candidate;
      } else {
        issues.push({ nodeId: row.node_id, state: candidate.state === 'missing' ? 'missing' : 'corrupt' });
      }
    }
    const repairTaskIds = await this.recordReplicaIssues(version, issues);
    if (!source) fail('integrity_failure', 'no verified replica is readable', 503);

    const range = byteRange(input.range, source.bytes.length);
    const selected = range ? source.bytes.subarray(range.start, range.endExclusive) : source.bytes;
    const result = {
      versionId: version.version_id,
      versionSequence: asNumber(version.version_sequence),
      contentDigest: version.content_digest,
      fullByteLength: source.bytes.length,
      returnedByteLength: selected.length,
      range,
      bodyBase64: selected.toString('base64'),
      evidence: {
        fullObjectDigestVerified: true,
        sourceReplica: source.nodeId,
        placementGeneration: asNumber(version.placement_generation),
        degradedReplicas: issues.length,
        repairTasksRecorded: repairTaskIds.length,
        sameHostOnly: true,
        clientConsumptionProved: false,
      },
      repairTaskIds,
    };
    this.logger({ event: 'object_read', outcome: 'verified', usedFallback: issues.length > 0, rangeUsed: Boolean(range) });
    return result;
  }

  async deleteObject(input) {
    exactKeys(input, ['requestKey', 'bucket', 'key', 'ifCurrentVersionId'], ['requestKey', 'bucket', 'key']);
    const request = requestKey(input.requestKey);
    const bucket = bucketName(input.bucket);
    const key = objectKey(input.key);
    const precondition = currentVersionPrecondition(input.ifCurrentVersionId);
    const operation = 'delete_object';
    const intentDigest = digestObject({ operation, bucket, key, precondition });
    const version = deterministicId('ver', { principal: this.principal, request, intentDigest });

    const result = await this.repository.withMutation({
      principal: this.principal,
      requestKey: request,
      operation,
      intentDigest,
      callback: async (client) => {
        await this.requireBucket(client, bucket);
        await this.lockKey(client, bucket, key);
        const current = await this.currentHead(client, bucket, key);
        if (!current) fail('not_found', 'object was not found', 404);
        this.assertPrecondition(precondition, current);
        const inserted = await client.query(
          `INSERT INTO object_versions
             (principal, bucket_name, object_key, version_id, kind, content_digest, byte_length,
              placement_generation, required_replicas, result_digest)
           VALUES ($1, $2, $3, $4, 'tombstone', NULL, NULL, $5, 0, $6)
           RETURNING version_sequence`,
          [this.principal, bucket, key, version, PLACEMENT_GENERATION, digestObject({ version, kind: 'tombstone' })],
        );
        await client.query(
          `UPDATE object_heads
              SET version_id = $4, head_generation = head_generation + 1, updated_at = statement_timestamp()
            WHERE principal = $1 AND bucket_name = $2 AND object_key = $3`,
          [this.principal, bucket, key, version],
        );
        return {
          versionId: version,
          versionSequence: asNumber(inserted.rows[0].version_sequence),
          kind: 'tombstone',
          metadataCommitted: true,
          physicalErasureProved: false,
          replayed: false,
        };
      },
    });
    killAt('OBJECT_CRASH_AFTER_DELETE_COMMIT');
    this.logger({ event: 'object_delete', outcome: 'tombstoned', replayed: result.replayed });
    return result;
  }

  async initiateMultipart(input) {
    exactKeys(input, ['requestKey', 'bucket', 'key', 'expectedParts', 'expiresInMs']);
    const request = requestKey(input.requestKey);
    const bucket = bucketName(input.bucket);
    const key = objectKey(input.key);
    const partCount = expectedParts(input.expectedParts);
    const lifetime = expiryMs(input.expiresInMs);
    const operation = 'initiate_multipart';
    const intentDigest = digestObject({ operation, bucket, key, expectedParts: partCount, expiresInMs: lifetime });
    const upload = deterministicId('upl', { principal: this.principal, request, intentDigest });

    const result = await this.repository.withMutation({
      principal: this.principal,
      requestKey: request,
      operation,
      intentDigest,
      callback: async (client) => {
        await this.requireBucket(client, bucket);
        const inserted = await client.query(
          `INSERT INTO multipart_uploads
             (principal, upload_id, bucket_name, object_key, expected_parts, placement_generation, state, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'open', statement_timestamp() + ($7::bigint * interval '1 millisecond'))
           RETURNING expires_at`,
          [this.principal, upload, bucket, key, partCount, PLACEMENT_GENERATION, lifetime],
        );
        return {
          uploadId: upload,
          state: 'open',
          expectedParts: partCount,
          expiresAt: inserted.rows[0].expires_at.toISOString(),
          replayed: false,
        };
      },
    });
    this.logger({ event: 'multipart_initiate', outcome: 'open', expectedParts: result.expectedParts });
    return result;
  }

  async loadUpload(upload) {
    const result = await this.repository.pool.query(
      `SELECT *, expires_at <= statement_timestamp() AS is_expired
         FROM multipart_uploads
        WHERE principal = $1 AND upload_id = $2`,
      [this.principal, upload],
    );
    if (result.rowCount === 0) fail('not_found', 'multipart upload was not found', 404);
    return result.rows[0];
  }

  assertUploadOpen(row) {
    if (row.state !== 'open' || row.is_expired) fail('upload_closed', 'multipart upload is closed', 409);
  }

  async putMultipartPart(input) {
    exactKeys(input, ['requestKey', 'uploadId', 'partNumber', 'content']);
    const request = requestKey(input.requestKey);
    const upload = uploadId(input.uploadId);
    const number = partNumber(input.partNumber);
    const { spec, bytes } = generatedContent(input.content);
    const contentDigest = sha256(bytes);
    const operation = `multipart_part:${upload}:${number}`;
    const intentDigest = digestObject({ operation, upload, partNumber: number, content: spec, contentDigest, byteLength: bytes.length });
    const directReplay = await this.repository.replayMutation({
      principal: this.principal,
      requestKey: request,
      operation,
      intentDigest,
    });
    if (directReplay) return directReplay;
    const uploadRow = await this.loadUpload(upload);
    this.assertUploadOpen(uploadRow);
    if (number > asNumber(uploadRow.expected_parts)) fail('invalid_input', 'part number exceeds expected part count');

    const reservation = await this.repository.reserveWriteIntent({
      principal: this.principal,
      requestKey: request,
      operation,
      intentDigest,
      contentDigest,
      byteLength: bytes.length,
      ttlMs: this.writeIntentTtlMs,
    });
    if (reservation.replay) return reservation.replay;
    const { receipts } = await this.prepareReplicas(bytes, contentDigest);

    const result = await this.repository.withMutation({
      principal: this.principal,
      requestKey: request,
      operation,
      intentDigest,
      callback: async (client) => {
        const locked = await client.query(
          `SELECT *, expires_at <= statement_timestamp() AS is_expired
             FROM multipart_uploads
            WHERE principal = $1 AND upload_id = $2
            FOR UPDATE`,
          [this.principal, upload],
        );
        if (locked.rowCount === 0) fail('not_found', 'multipart upload was not found', 404);
        this.assertUploadOpen(locked.rows[0]);
        const existing = await client.query(
          `SELECT content_digest, byte_length, content_spec, result
             FROM multipart_parts
            WHERE principal = $1 AND upload_id = $2 AND part_number = $3`,
          [this.principal, upload, number],
        );
        if (existing.rowCount > 0) {
          const row = existing.rows[0];
          if (row.content_digest !== contentDigest || asNumber(row.byte_length) !== bytes.length
              || digestObject(row.content_spec) !== digestObject(spec)) {
            fail('intent_conflict', 'part number is already bound to different bytes', 409);
          }
          await this.repository.clearWriteIntent(client, this.principal, request, operation);
          return { ...row.result, replayed: true };
        }
        await this.repository.assertWriteIntent(client, this.principal, request, operation, intentDigest, contentDigest);
        await this.repository.lockGcReferences(client, 'SHARE');
        await this.recordReplicaRows(client, contentDigest, bytes.length, receipts);
        const partResult = {
          uploadId: upload,
          partNumber: number,
          contentDigest,
          byteLength: bytes.length,
          verifiedReplicas: receipts.length,
          requiredReplicas: REQUIRED_REPLICAS,
          sameHostOnly: true,
          replayed: false,
        };
        await client.query(
          `INSERT INTO multipart_parts
             (principal, upload_id, part_number, content_digest, byte_length, content_spec, result)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
          [this.principal, upload, number, contentDigest, bytes.length, JSON.stringify(spec), JSON.stringify(partResult)],
        );
        await this.repository.clearWriteIntent(client, this.principal, request, operation);
        return partResult;
      },
    });
    killAt('OBJECT_CRASH_AFTER_PART_COMMIT');
    this.logger({ event: 'multipart_part', outcome: 'committed', verifiedReplicas: result.verifiedReplicas });
    return result;
  }

  async readPartBytes(row) {
    for (const nodeId of NODE_IDS) {
      const candidate = await this.replicaStore.verify(nodeId, row.content_digest, { includeBytes: true });
      if (candidate.state === 'verified' && candidate.byteLength === asNumber(row.byte_length)) return candidate.bytes;
    }
    fail('integrity_failure', 'multipart part has no verified replica', 503);
  }

  async completeMultipart(input) {
    exactKeys(
      input,
      ['requestKey', 'uploadId', 'parts', 'ifCurrentVersionId'],
      ['requestKey', 'uploadId', 'parts'],
    );
    const request = requestKey(input.requestKey);
    const upload = uploadId(input.uploadId);
    const uploadRow = await this.loadUpload(upload);
    const sequence = partSequence(input.parts, asNumber(uploadRow.expected_parts));
    const precondition = currentVersionPrecondition(input.ifCurrentVersionId);
    if (!['open', 'completed'].includes(uploadRow.state) || (uploadRow.state === 'open' && uploadRow.is_expired)) {
      fail('upload_closed', 'multipart upload is closed', 409);
    }
    const parts = await this.repository.pool.query(
      `SELECT part_number, content_digest, byte_length
         FROM multipart_parts
        WHERE principal = $1 AND upload_id = $2
        ORDER BY part_number`,
      [this.principal, upload],
    );
    if (parts.rowCount !== sequence.length
        || parts.rows.some((row, index) => asNumber(row.part_number) !== sequence[index])) {
      fail('parts_incomplete', 'multipart upload does not contain the declared parts', 409);
    }
    const partDigests = parts.rows.map((row) => row.content_digest);
    const operation = `complete_multipart:${upload}`;
    const intentDigest = digestObject({ operation, upload, parts: sequence, precondition, partDigests });
    const version = deterministicId('ver', { principal: this.principal, upload, intentDigest });
    const directReplay = await this.repository.replayMutation({
      principal: this.principal,
      requestKey: request,
      operation,
      intentDigest,
    });
    if (directReplay) return directReplay;
    if (uploadRow.state === 'completed') {
      if (uploadRow.completion_intent_digest !== intentDigest) {
        fail('intent_conflict', 'upload already completed with different intent', 409);
      }
      return this.repository.withMutation({
        principal: this.principal,
        requestKey: request,
        operation,
        intentDigest,
        callback: async () => ({ ...uploadRow.completion_result, replayed: true }),
      });
    }

    const buffers = [];
    for (const row of parts.rows) buffers.push(await this.readPartBytes(row));
    const bytes = Buffer.concat(buffers);
    if (bytes.length > MAX_BYTES) fail('capacity_exceeded', 'completed object exceeds 65536 bytes', 413);
    const contentDigest = sha256(bytes);

    const reservation = await this.repository.reserveWriteIntent({
      principal: this.principal,
      requestKey: request,
      operation,
      intentDigest,
      contentDigest,
      byteLength: bytes.length,
      ttlMs: this.writeIntentTtlMs,
    });
    if (reservation.replay) return reservation.replay;
    const { receipts } = await this.prepareReplicas(bytes, contentDigest);

    const result = await this.repository.withMutation({
      principal: this.principal,
      requestKey: request,
      operation,
      intentDigest,
      callback: async (client) => {
        const locked = await client.query(
          `SELECT *, expires_at <= statement_timestamp() AS is_expired
             FROM multipart_uploads
            WHERE principal = $1 AND upload_id = $2
            FOR UPDATE`,
          [this.principal, upload],
        );
        if (locked.rowCount === 0) fail('not_found', 'multipart upload was not found', 404);
        const row = locked.rows[0];
        if (row.state === 'completed') {
          if (row.completion_intent_digest !== intentDigest) {
            fail('intent_conflict', 'upload already completed with different intent', 409);
          }
          await this.repository.clearWriteIntent(client, this.principal, request, operation);
          return { ...row.completion_result, replayed: true };
        }
        this.assertUploadOpen(row);
        const lockedParts = await client.query(
          `SELECT part_number, content_digest
             FROM multipart_parts
            WHERE principal = $1 AND upload_id = $2
            ORDER BY part_number`,
          [this.principal, upload],
        );
        if (lockedParts.rowCount !== sequence.length
            || lockedParts.rows.some((part, index) => (
              asNumber(part.part_number) !== sequence[index] || part.content_digest !== partDigests[index]
            ))) fail('parts_incomplete', 'multipart parts changed before completion', 409);
        await this.repository.assertWriteIntent(client, this.principal, request, operation, intentDigest, contentDigest);
        const committed = await this.insertDataVersion(client, {
          bucket: row.bucket_name,
          key: row.object_key,
          version,
          contentDigest,
          byteLength: bytes.length,
          receipts,
          precondition,
        });
        const completion = { ...committed, uploadId: upload, orderedParts: sequence };
        await client.query(
          `UPDATE multipart_uploads
              SET state = 'completed', completed_version_id = $3, completion_intent_digest = $4,
                  completion_result = $5::jsonb, updated_at = statement_timestamp()
            WHERE principal = $1 AND upload_id = $2`,
          [this.principal, upload, version, intentDigest, JSON.stringify(completion)],
        );
        await this.repository.clearWriteIntent(client, this.principal, request, operation);
        return completion;
      },
    });
    killAt('OBJECT_CRASH_AFTER_COMPLETE_COMMIT');
    this.logger({ event: 'multipart_complete', outcome: 'committed', parts: sequence.length });
    return result;
  }

  async abortMultipart(input) {
    exactKeys(input, ['requestKey', 'uploadId']);
    const request = requestKey(input.requestKey);
    const upload = uploadId(input.uploadId);
    const operation = `abort_multipart:${upload}`;
    const intentDigest = digestObject({ operation, upload });
    const result = await this.repository.withMutation({
      principal: this.principal,
      requestKey: request,
      operation,
      intentDigest,
      callback: async (client) => {
        const locked = await client.query(
          `SELECT *, expires_at <= statement_timestamp() AS is_expired
             FROM multipart_uploads
            WHERE principal = $1 AND upload_id = $2
            FOR UPDATE`,
          [this.principal, upload],
        );
        if (locked.rowCount === 0) fail('not_found', 'multipart upload was not found', 404);
        const row = locked.rows[0];
        if (row.state === 'completed') fail('upload_closed', 'completed upload cannot be aborted', 409);
        const nextState = row.is_expired ? 'expired' : 'aborted';
        if (row.state === 'open') {
          await client.query(
            `UPDATE multipart_uploads SET state = $3, updated_at = statement_timestamp()
              WHERE principal = $1 AND upload_id = $2`,
            [this.principal, upload, nextState],
          );
        }
        return { uploadId: upload, state: row.state === 'open' ? nextState : row.state, bytesReclaimed: false, replayed: false };
      },
    });
    this.logger({ event: 'multipart_abort', outcome: result.state });
    return result;
  }

  async createListSnapshot(input) {
    exactKeys(input, ['requestKey', 'bucket', 'prefix', 'includeTombstones'], ['requestKey', 'bucket']);
    const request = requestKey(input.requestKey);
    const bucket = bucketName(input.bucket);
    const prefix = objectKey(input.prefix ?? '', { allowEmpty: true });
    const includeDeleted = includeTombstones(input.includeTombstones);
    const operation = 'create_list_snapshot';
    const intentDigest = digestObject({ operation, bucket, prefix, includeTombstones: includeDeleted });
    const snapshot = deterministicId('lst', { principal: this.principal, request, intentDigest });

    const result = await this.repository.withMutation({
      principal: this.principal,
      requestKey: request,
      operation,
      intentDigest,
      isolation: 'REPEATABLE READ',
      callback: async (client) => {
        await this.requireBucket(client, bucket);
        const selected = await client.query(
          `SELECT v.object_key, v.version_id, v.version_sequence, v.kind, v.content_digest, v.byte_length
             FROM object_heads h
             JOIN object_versions v
               ON v.principal = h.principal
              AND v.bucket_name = h.bucket_name
              AND v.object_key = h.object_key
              AND v.version_id = h.version_id
            WHERE h.principal = $1 AND h.bucket_name = $2
              AND left(v.object_key, length($3)) = $3
              AND ($4::boolean OR v.kind <> 'tombstone')
            ORDER BY v.object_key COLLATE "C"
            LIMIT $5`,
          [this.principal, bucket, prefix, includeDeleted, MAX_LIST_ITEMS + 1],
        );
        if (selected.rowCount > MAX_LIST_ITEMS) fail('capacity_exceeded', 'list snapshot exceeds 256 items', 413);
        const items = selected.rows.map((row) => ({
          key: row.object_key,
          versionId: row.version_id,
          versionSequence: asNumber(row.version_sequence),
          kind: row.kind,
          contentDigest: row.content_digest,
          byteLength: row.byte_length === null ? null : asNumber(row.byte_length),
        }));
        await client.query(
          `INSERT INTO list_snapshots
             (principal, snapshot_id, bucket_name, prefix, include_tombstones, items, item_count)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [this.principal, snapshot, bucket, prefix, includeDeleted, JSON.stringify(items), items.length],
        );
        return {
          snapshotId: snapshot,
          itemCount: items.length,
          items: items.slice(0, 16),
          nextOffset: items.length > 16 ? 16 : null,
          materialized: true,
          replayed: false,
        };
      },
    });
    this.logger({ event: 'list_snapshot', outcome: 'materialized', itemCount: result.itemCount });
    return result;
  }

  async getListPage(input) {
    exactKeys(input, ['snapshotId', 'offset', 'limit']);
    const snapshot = snapshotId(input.snapshotId);
    const offset = pageOffset(input.offset);
    const limit = pageLimit(input.limit);
    const query = await this.repository.pool.query(
      `SELECT items, item_count FROM list_snapshots WHERE principal = $1 AND snapshot_id = $2`,
      [this.principal, snapshot],
    );
    if (query.rowCount === 0) fail('not_found', 'list snapshot was not found', 404);
    const items = query.rows[0].items;
    const page = pageSnapshot(items, offset, limit);
    return {
      snapshotId: snapshot,
      offset,
      limit,
      items: page.items,
      nextOffset: page.nextOffset,
      materialized: true,
    };
  }

  async repair(input) {
    exactKeys(input, ['requestKey', 'taskId', 'expectedMaintenanceGeneration']);
    const request = requestKey(input.requestKey);
    const task = taskId(input.taskId);
    const expected = generation(input.expectedMaintenanceGeneration, 'expectedMaintenanceGeneration');
    const taskQuery = await this.repository.pool.query(
      `SELECT t.*, v.byte_length AS manifest_byte_length, g.generation AS current_generation
         FROM repair_tasks t
         JOIN object_versions v
           ON v.principal = t.principal
          AND v.bucket_name = t.bucket_name
          AND v.object_key = t.object_key
          AND v.version_id = t.version_id
         JOIN maintenance_generations g ON g.kind = 'repair'
        WHERE t.principal = $1 AND t.task_id = $2`,
      [this.principal, task],
    );
    if (taskQuery.rowCount === 0) fail('not_found', 'repair task was not found', 404);
    const taskRow = taskQuery.rows[0];
    const operation = `repair:${task}`;
    const intentDigest = digestObject({ operation, task, expected, contentDigest: taskRow.content_digest });
    const directReplay = await this.repository.replayMutation({
      principal: this.principal,
      requestKey: request,
      operation,
      intentDigest,
    });
    if (directReplay) return directReplay;
    if (asNumber(taskRow.current_generation) !== expected || asNumber(taskRow.maintenance_generation) !== expected) {
      fail('stale_generation', 'repair generation is stale', 409);
    }
    const sources = await this.repository.pool.query(
      `SELECT node_id FROM version_replicas
        WHERE principal = $1 AND bucket_name = $2 AND object_key = $3 AND version_id = $4 AND node_id <> $5
        ORDER BY node_id`,
      [this.principal, taskRow.bucket_name, taskRow.object_key, taskRow.version_id, taskRow.target_node_id],
    );
    let source = null;
    for (const row of sources.rows) {
      const candidate = await this.replicaStore.verify(row.node_id, taskRow.content_digest, { includeBytes: true });
      if (candidate.state === 'verified' && candidate.byteLength === asNumber(taskRow.manifest_byte_length)) {
        source = candidate;
        break;
      }
    }
    if (!source) fail('integrity_failure', 'repair has no verified source', 503);
    const receipt = await this.replicaStore.publish(taskRow.target_node_id, source.bytes, taskRow.content_digest);
    const result = await this.repository.withMutation({
      principal: this.principal,
      requestKey: request,
      operation,
      intentDigest,
      callback: async (client) => {
        const lockedGeneration = await client.query(
          "SELECT generation FROM maintenance_generations WHERE kind = 'repair' FOR SHARE",
        );
        if (asNumber(lockedGeneration.rows[0].generation) !== expected) {
          fail('stale_generation', 'repair generation changed', 409);
        }
        const lockedTask = await client.query(
          `SELECT * FROM repair_tasks WHERE principal = $1 AND task_id = $2 FOR UPDATE`,
          [this.principal, task],
        );
        const row = lockedTask.rows[0];
        if (!row || asNumber(row.maintenance_generation) !== expected || row.state !== 'pending') {
          fail('stale_generation', 'repair task is no longer current', 409);
        }
        await client.query(
          `UPDATE replicas
              SET state = 'verified', byte_length = $4, receipt_digest = $5,
                  verified_at = statement_timestamp(), updated_at = statement_timestamp()
            WHERE content_digest = $1 AND node_id = $2 AND placement_generation = $3`,
          [taskRow.content_digest, taskRow.target_node_id, asNumber(taskRow.placement_generation), source.bytes.length, receipt.receiptDigest],
        );
        const repairResult = {
          taskId: task,
          state: 'repaired',
          maintenanceGeneration: expected,
          placementGeneration: asNumber(taskRow.placement_generation),
          readbackVerified: true,
          sameHostOnly: true,
          replayed: false,
        };
        await client.query(
          `UPDATE repair_tasks
              SET state = 'repaired', result = $3::jsonb, updated_at = statement_timestamp()
            WHERE principal = $1 AND task_id = $2`,
          [this.principal, task, JSON.stringify(repairResult)],
        );
        return repairResult;
      },
    });
    this.logger({ event: 'replica_repair', outcome: 'verified', generationMatched: true });
    return result;
  }

  async advanceMaintenanceGeneration(input) {
    exactKeys(input, ['requestKey', 'kind']);
    const request = requestKey(input.requestKey);
    if (!['repair', 'gc'].includes(input.kind)) fail('invalid_input', 'maintenance kind is invalid');
    const kind = input.kind;
    const operation = `advance_generation:${kind}`;
    const intentDigest = digestObject({ operation, kind });
    return this.repository.withMutation({
      principal: this.principal,
      requestKey: request,
      operation,
      intentDigest,
      callback: async (client) => {
        const updated = await client.query(
          `UPDATE maintenance_generations
              SET generation = generation + 1, updated_at = statement_timestamp()
            WHERE kind = $1
            RETURNING generation`,
          [kind],
        );
        if (kind === 'repair') {
          await client.query(
            `UPDATE repair_tasks SET state = 'superseded', updated_at = statement_timestamp()
              WHERE principal = $1 AND state = 'pending' AND maintenance_generation < $2`,
            [this.principal, updated.rows[0].generation],
          );
        }
        return { kind, generation: asNumber(updated.rows[0].generation), replayed: false };
      },
    });
  }

  async liveDigests(client = this.repository.pool) {
    const result = await client.query(
      `SELECT content_digest FROM object_versions WHERE principal = $1 AND kind = 'data'
       UNION
       SELECT p.content_digest
         FROM multipart_parts p
         JOIN multipart_uploads u ON u.principal = p.principal AND u.upload_id = p.upload_id
        WHERE p.principal = $1 AND u.state = 'open' AND u.expires_at > statement_timestamp()
       UNION
       SELECT content_digest FROM write_intents WHERE principal = $1 AND expires_at > statement_timestamp()`,
      [this.principal],
    );
    return new Set(result.rows.map((row) => row.content_digest));
  }

  async scanOrphans(input) {
    exactKeys(input, ['requestKey', 'expectedMaintenanceGeneration', 'minimumAgeMs']);
    const request = requestKey(input.requestKey);
    const expected = generation(input.expectedMaintenanceGeneration, 'expectedMaintenanceGeneration');
    const age = minimumAgeMs(input.minimumAgeMs);
    const operation = 'orphan_scan';
    const intentDigest = digestObject({ operation, expected, minimumAgeMs: age });
    const scan = deterministicId('scn', { principal: this.principal, request, intentDigest });
    const live = await this.liveDigests();
    const observedAt = nowMs();
    const entries = await this.replicaStore.listEntries();
    const { candidates, recentCount } = classifyOrphanEntries(entries, live, observedAt, age);
    const result = await this.repository.withMutation({
      principal: this.principal,
      requestKey: request,
      operation,
      intentDigest,
      callback: async (client) => {
        const current = await client.query(
          "SELECT generation FROM maintenance_generations WHERE kind = 'gc' FOR SHARE",
        );
        if (asNumber(current.rows[0].generation) !== expected) fail('stale_generation', 'scan generation is stale', 409);
        await client.query(
          `INSERT INTO orphan_scans
             (principal, scan_id, maintenance_generation, minimum_age_ms, items, candidate_count, recent_count)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
          [this.principal, scan, expected, age, JSON.stringify(candidates), candidates.length, recentCount],
        );
        return {
          scanId: scan,
          maintenanceGeneration: expected,
          observedFiles: entries.length,
          candidateCount: candidates.length,
          recentCount,
          deletedCount: 0,
          replayed: false,
        };
      },
    });
    this.logger({ event: 'orphan_scan', outcome: 'recorded', candidateCount: result.candidateCount });
    return result;
  }

  async garbageCollect(input) {
    exactKeys(input, ['requestKey', 'scanId', 'expectedMaintenanceGeneration', 'retentionMs']);
    const request = requestKey(input.requestKey);
    const scan = scanId(input.scanId);
    const expected = generation(input.expectedMaintenanceGeneration, 'expectedMaintenanceGeneration');
    const retention = minimumAgeMs(input.retentionMs);
    const operation = `garbage_collect:${scan}`;
    const intentDigest = digestObject({ operation, scan, expected, retentionMs: retention });
    const run = deterministicId('gcr', { principal: this.principal, request, intentDigest });

    const result = await this.repository.withMutation({
      principal: this.principal,
      requestKey: request,
      operation,
      intentDigest,
      callback: async (client) => {
        const currentGeneration = await this.repository.lockGcReferences(client, 'UPDATE');
        if (currentGeneration !== expected) fail('stale_generation', 'GC generation is stale', 409);
        const scanResult = await client.query(
          `SELECT * FROM orphan_scans WHERE principal = $1 AND scan_id = $2 FOR UPDATE`,
          [this.principal, scan],
        );
        if (scanResult.rowCount === 0) fail('not_found', 'orphan scan was not found', 404);
        if (asNumber(scanResult.rows[0].maintenance_generation) !== expected) {
          fail('stale_generation', 'orphan scan belongs to an older generation', 409);
        }
        const currentEntries = new Map(
          (await this.replicaStore.listEntries()).map((entry) => [`${entry.nodeId}:${entry.entryName}`, entry]),
        );
        const clock = await client.query('SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS now_ms');
        const databaseNow = asNumber(clock.rows[0].now_ms);
        let deletedCount = 0;
        let keptCount = 0;
        for (const item of scanResult.rows[0].items) {
          const current = currentEntries.get(`${item.nodeId}:${item.entryName}`);
          if (!current || current.mtimeMs > item.mtimeMs || databaseNow - current.mtimeMs < retention) {
            keptCount += 1;
            continue;
          }
          if (item.kind === 'blob') {
            const reachable = await client.query(
              `SELECT EXISTS (
                 SELECT 1 FROM object_versions
                  WHERE principal = $1 AND kind = 'data' AND content_digest = $2
                 UNION ALL
                 SELECT 1
                   FROM multipart_parts p
                   JOIN multipart_uploads u ON u.principal = p.principal AND u.upload_id = p.upload_id
                  WHERE p.principal = $1 AND p.content_digest = $2
                    AND u.state = 'open' AND u.expires_at > statement_timestamp()
                 UNION ALL
                 SELECT 1 FROM write_intents
                  WHERE principal = $1 AND content_digest = $2 AND expires_at > statement_timestamp()
               ) AS reachable`,
              [this.principal, item.digest],
            );
            if (reachable.rows[0].reachable) {
              keptCount += 1;
              continue;
            }
          }
          await this.replicaStore.deleteEntry(item.nodeId, item.entryName);
          deletedCount += 1;
        }
        const gcResult = {
          runId: run,
          scanId: scan,
          maintenanceGeneration: expected,
          deletedCount,
          keptCount,
          directorySyncCompleted: deletedCount > 0,
          legalErasureProved: false,
          replayed: false,
        };
        await client.query(
          `INSERT INTO gc_runs
             (principal, run_id, scan_id, maintenance_generation, deleted_count, kept_count, result)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [this.principal, run, scan, expected, deletedCount, keptCount, JSON.stringify(gcResult)],
        );
        return gcResult;
      },
    });
    this.logger({ event: 'garbage_collect', outcome: 'completed', deletedCount: result.deletedCount, keptCount: result.keptCount });
    return result;
  }

  async state() {
    const result = await this.repository.pool.query(
      `SELECT
         (SELECT count(*) FROM buckets WHERE principal = $1)::int AS buckets,
         (SELECT count(*) FROM object_heads WHERE principal = $1)::int AS current_keys,
         (SELECT count(*) FROM object_versions WHERE principal = $1 AND kind = 'data')::int AS data_versions,
         (SELECT count(*) FROM object_versions WHERE principal = $1 AND kind = 'tombstone')::int AS tombstones,
         (SELECT count(*) FROM replicas WHERE state = 'verified')::int AS verified_replicas,
         (SELECT count(*) FROM replicas WHERE state = 'missing')::int AS missing_replicas,
         (SELECT count(*) FROM replicas WHERE state = 'corrupt')::int AS corrupt_replicas,
         (SELECT count(*) FROM multipart_uploads WHERE principal = $1 AND state = 'open')::int AS open_uploads,
         (SELECT count(*) FROM multipart_uploads WHERE principal = $1 AND state = 'completed')::int AS completed_uploads,
         (SELECT count(*) FROM repair_tasks WHERE principal = $1 AND state = 'pending')::int AS pending_repairs,
         (SELECT count(*) FROM list_snapshots WHERE principal = $1)::int AS list_snapshots,
         (SELECT count(*) FROM write_intents WHERE principal = $1)::int AS write_intents,
         (SELECT count(*) FROM orphan_scans WHERE principal = $1)::int AS orphan_scans,
         (SELECT count(*) FROM gc_runs WHERE principal = $1)::int AS gc_runs,
         (SELECT generation FROM maintenance_generations WHERE kind = 'repair')::int AS repair_generation,
         (SELECT generation FROM maintenance_generations WHERE kind = 'gc')::int AS gc_generation,
         (SELECT count(*)
            FROM object_versions v
           WHERE v.principal = $1 AND v.kind = 'data'
             AND (SELECT count(*)
                    FROM version_replicas vr
                    JOIN replicas r
                      ON r.content_digest = vr.content_digest
                     AND r.node_id = vr.node_id
                     AND r.placement_generation = vr.placement_generation
                   WHERE vr.principal = v.principal
                     AND vr.bucket_name = v.bucket_name
                     AND vr.object_key = v.object_key
                     AND vr.version_id = v.version_id
                     AND r.state = 'verified') < v.required_replicas)::int AS under_replicated_versions,
         (SELECT count(*)
            FROM object_heads h
            LEFT JOIN object_versions v
              ON v.principal = h.principal
             AND v.bucket_name = h.bucket_name
             AND v.object_key = h.object_key
             AND v.version_id = h.version_id
           WHERE h.principal = $1 AND v.version_id IS NULL)::int AS dangling_heads`,
      [this.principal],
    );
    const row = result.rows[0];
    const invariantViolations = asNumber(row.under_replicated_versions) + asNumber(row.dangling_heads);
    return {
      ...Object.fromEntries(Object.entries(row).map(([key, value]) => [key, asNumber(value)])),
      invariantViolations,
      sameHostOnly: true,
      s3CompatibilityProved: false,
      durabilityPercentageProved: false,
      backupRestoreProved: false,
      externalAcceptanceProved: false,
    };
  }
}
