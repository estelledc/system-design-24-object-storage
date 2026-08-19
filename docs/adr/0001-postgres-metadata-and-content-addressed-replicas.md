# ADR 0001: PostgreSQL visibility authority with content-addressed verified replicas

- Status: accepted for v0.1 design
- Date: 2026-08-19

## Context

The central unknown is not whether an architecture can name buckets, metadata shards, storage nodes, replication, and garbage
collection. It is whether every object version remains explainable when filesystem effects and a metadata transaction cannot share
one atomic commit.

A write can leave bytes without metadata, metadata can commit before the caller receives a response, one replica can corrupt after
publication, multipart completion can race abort, and a stale worker can delete bytes that became reachable again. Adding a broker,
consensus group, packed-file compactor, erasure coding, or multi-region database before these boundaries are executable would add
more acknowledgements without proving the first invariant.

## Decision

Use PostgreSQL 17 as the sole bucket, immutable-version, current-pointer, request-receipt, multipart-session, list-snapshot, repair,
and maintenance-generation authority. Store bytes in three fixed content-addressed directories on one host.

- A generated object or part is bounded to 64 KiB, hashed with SHA-256, and never mapped from its logical key to a filesystem path.
- Each node writes a temp file in the final directory, syncs the file, renames it, syncs the parent directory, reopens it, and
  verifies length/digest. Existing exact content can be adopted after a crash.
- Normal writes target all three directories; metadata visibility requires at least two verified replicas. These are same-host
  receipts, not independent disk/host/rack/region durability.
- Files are written before the metadata transaction. A failed/rolled-back transaction can therefore create an orphan; it cannot
  create a visible version. Reachability plus retention plus a maintenance generation governs deletion.
- Request and entity identities bind a canonical intent digest. Exact retries return the stored result; changed intent conflicts.
- A key mutation takes a stable advisory lock. Version, current pointer, replica references, and response receipt commit together.
- Every overwrite creates an immutable version. DELETE creates a tombstone version. Explicit retained versions stay readable.
- Multipart parts are immutable within one upload. Completion verifies the exact declared sequence, constructs and replicates one
  final content digest, then commits one version and one completion result.
- LIST stores one bounded ordered result under one snapshot ID in a Repeatable Read transaction. Pages read that stored result.
- GET verifies the entire selected replica before returning a full body or range. Missing/corrupt copies create repair work; a
  verified fallback can serve the request. Repair is generation-fenced and copy-then-verify.
- Ordinary state and logs remain low-cardinality. No bucket/key/request/version/upload/digest/path/principal/content enters logs.

## Alternatives rejected for this slice

- **Metadata first, bytes later:** can expose a row that has no verified readable content.
- **One database `bytea` value:** would remove the cross-system boundary this lab is meant to test.
- **In-memory metadata:** cannot justify response-loss replay, restart behavior, or list/version authority.
- **Separate broker/outbox:** useful for independent workers, but adds a publish/checkpoint protocol before storage correctness is
  established.
- **Packed append files and compaction:** useful for small-file efficiency, but require crash-tail recovery, mapping generations,
  concurrent-read fencing, and compaction rollback that are not needed for v0.1.
- **Three copies imply durability:** ignores shared host/filesystem/device dependencies and repair/corruption assumptions.
- **Automatic delete of unreferenced files:** can race an in-flight pre-metadata write. Retention and current generation are required.
- **Reference count as sole GC truth:** a crash can drift counts. Reachability is derived from committed manifests/open parts.
- **Silent multipart part replacement:** matches an S3 behavior but weakens immutable response-loss recovery; compatibility is not a
  v0.1 goal.
- **Trusting filename or ETag:** neither proves the bytes just read. The lab recomputes a full SHA-256 digest.

## Consequences

- PostgreSQL and the one host are availability and scaling boundaries. There is no metadata quorum, storage-node RPC, or independent
  fault domain.
- Three full copies amplify local writes and directory operations. The benchmark reports this exact cost without extrapolation.
- Verifying an entire object before a range is intentionally expensive; bounded objects make the integrity rule executable. A
  production design would need authenticated chunk manifests or another range-integrity scheme.
- Content addressing permits deduplication/adoption, but physical deletion must consider every retained version and open part.
- The lab can prove file/process/database recovery for its fixture. It cannot prove power-loss behavior beyond the operating-system
  contract, backup, restore, legal erasure, cloud durability, SLA, or external acceptance.
- Any future packed storage, erasure coding, independent nodes, consensus, signed API, arbitrary streaming body, multi-region
  authority, lifecycle policy, backup/restore, or S3 compatibility requires a new ADR and executable failure matrix.
