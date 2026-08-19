# Operations and recovery

## Local prerequisites

- Node.js 22 or newer;
- PostgreSQL 17 with a disposable database;
- a writable temporary directory on one local filesystem;
- no cloud account, public endpoint, credential, object, or user file.

Install locked dependencies, apply `sql/schema.sql`, set the synthetic API token and database URL, then run the gates described in
[verification](verification.md). Infrastructure tests fail rather than skip when PostgreSQL or filesystem setup is missing.

## What to observe

`GET /v1/state` and test/benchmark receipts expose bounded counts:

- buckets, current keys, data versions, tombstones, open/completed/closed uploads;
- verified, missing, corrupt, and repair-pending same-host replicas;
- list snapshots/items, orphan observations, deleted orphan files, invariant violations;
- placement and maintenance generations;
- exact fixture bytes/files/operations and explicit false evidence for backup/restore and external acceptance.

Ordinary telemetry must not contain bucket/key/request/version/upload/list IDs, digests, paths, bytes, token, principal, node host
identity, SQL, or raw errors.

## Failure response

### Crash after the first verified replica

1. The killed process has no metadata commit receipt.
2. Current GET cannot expose the intended version.
3. Inspect only low-cardinality scan counts; do not log the digest/path.
4. Retry the exact request. Content-addressed verification may adopt the existing exact file and fill the missing copies.
5. A changed request key/intent cannot adopt it as the original operation.

### Crash after PUT metadata commit

1. Read the mutation receipt using the same request identity.
2. Exact retry returns the original version ID and result.
3. Confirm current GET names that one version and no duplicate version was created.

### Multipart part or completion response loss

1. Exact part retry returns its original digest/length receipt; changed bytes conflict.
2. Exact completion retry returns its original completed version; it does not concatenate or publish again.
3. Abort/expiry after committed completion remains closed and cannot hide the completed object.

### Missing or corrupt preferred replica

1. GET verifies candidates and never returns known-bad bytes.
2. A healthy fallback can serve the request and creates one repair task.
3. Run repair with current placement and maintenance generations.
4. Verify target readback and state. If no healthy source exists, return `integrity_failure`; do not fabricate empty bytes.

### Orphans and GC

1. Scan records candidates only after a configured minimum age.
2. GC waits for retention, rechecks database reachability, and verifies current worker generation.
3. Advance the generation to demonstrate a stale run is fenced.
4. Delete within configured node directories only; sync the directory and report counts.
5. Treat every recent, malformed, referenced, or ambiguous file as keep/abstain.

## Invariant checks

Operational checks should report nonzero violations for:

- visible data version below its required verified replica count;
- current pointer to a missing version;
- completed upload without a completed version/result;
- open upload with a completion result;
- repair task targeting a digest not present in the manifest;
- materialized list exceeding bounds;
- referenced digest missing from every verified replica.

The state endpoint cannot prove itself healthy during a database outage and cannot prove storage outside its configured local
directories. A zero violation count is only a successful local query at that moment.

## Retention and restore boundary

The executable GC retention is seconds/minutes for tests, not a production policy. The repository does not create or validate a
backup, snapshot, off-host copy, restore, RPO, RTO, legal hold, or secure erasure. Copying the repository or PostgreSQL dump is not a
restore test unless a future workflow explicitly rebuilds both metadata and verified bytes and compares manifests.
