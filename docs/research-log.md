# Source comparison and evidence log

## Evidence policy

The initial contract at commit `76a87918dbed530b33c7a9231656961435433aa4` was written from the title alone. The secondary
repository has no detected license at fixed commit `9d8388721e7231442763ad37398b8d82224aa68f`, so this repository copies no prose,
diagrams, schemas, code, fixtures, or benchmark values. Sources challenge the closed-book contract and calibrate independently
written decisions.

Search discovery is not verification. One `journal-search public` query returned the intended repository through Exa and the
GitHub adapter. The exact chapter path/blob was then resolved through the GitHub tree API; its raw fixed-commit URL and every
successfully acquired primary page below were stored in separate evidence bundles with valid local verification. TraceFetch
receipts are unsigned acquisition diagnostics, not third-party attestations or proof that a source's claims are true.

## Fixed secondary chapter

- Source: [`liquidslr/system-design-notes`, chapter 24](https://github.com/liquidslr/system-design-notes/blob/9d8388721e7231442763ad37398b8d82224aa68f/24.%20S3-like%20Object%20Storage/README.md)
- Tree commit: `9d8388721e7231442763ad37398b8d82224aa68f`
- Chapter blob: `20ab041318a6b30006604c09e0510725fbe2427b`
- TraceFetch receipt: `tf_33a21e49849769da_20260819T015151Z`
- Raw SHA-256: `33a21e49849769daef7214e298e1e3ca5e9389480a486de4f5434ef145052b96`
- Verification: valid, HTTP 200, complete, not truncated; license remains unresolved, so the content is reference-only.

### Confirmed by the chapter

- Object bytes and searchable metadata have different access paths and failure boundaries.
- A successful upload needs a defined order between data placement and metadata visibility.
- Replication, placement, checksums, repair, versioning, multipart uploads, tombstones, orphan data, and compaction are correctness
  concerns, not merely boxes in an architecture diagram.
- Prefix listing can become a scatter/gather problem when object metadata is sharded independently of bucket/prefix locality.
- Large uploads need bounded parts and a completion manifest; abandoned parts need an explicit reclamation owner.
- Deleting a versioned logical key can create a marker while old versions and physical bytes remain.

### Added after reading

- v0.1 tests one single-authority metadata database and three same-host directories. It does not reproduce the chapter's
  multi-host consensus, erasure coding, append-file compaction, 100 PB estimate, or availability/durability targets.
- Every file publication separates write completion, file fsync, rename, parent-directory fsync, and full readback verification.
- Content-addressed paths allow an exact retry to adopt already verified bytes after a crash, while metadata remains the only
  authority for logical visibility.
- LIST results are materialized snapshots. Live offset pagination over moving shards is intentionally excluded.
- One full SHA-256 digest is the version validator and replica identity. A range is returned only after verifying the whole bounded
  object, so a slice is never treated as independent whole-object integrity evidence.

### Conflicts and corrections

1. Object storage is not inherently only cold/archive storage. The chapter's comparison table is a useful simplification, not a
   universal workload boundary.
2. “Objects are immutable” needs a layer. Stored versions can be immutable while a logical key's current pointer changes; provider
   versioning may also be disabled. v0.1 always creates immutable versions and moves a current pointer.
3. Strong consistency and globally unique bucket names are current Amazon S3 product behaviors with scope and namespace details,
   not invariants of every object store. v0.1 claims only read-after-commit behavior through one PostgreSQL authority.
4. Three replicas and one annualized disk-failure percentage do not derive a durability figure. Correlated failures, fault-domain
   independence, latent corruption, scrub interval, repair latency, capacity, operator mistakes, software bugs, deletion, and
   disaster recovery are missing variables. v0.1 publishes no durability percentage.
5. “Replicate before response” does not define whether each acknowledgement means buffered write, file fsync, directory fsync, or
   verified readback, nor whether metadata can commit with fewer receipts. v0.1 names every boundary and requires two verified
   same-host copies before visibility.
6. Consistent hashing does not by itself define replica independence, placement generations, movement safety, or stale-worker
   fencing. The lab binds every manifest and repair to an explicit placement generation.
7. Append files plus an index omit crash-safe index/WAL ordering, directory durability, truncated tails, compaction fencing, and
   read-after-rewrite behavior. v0.1 uses one bounded content-addressed file per digest instead.
8. The metadata-sharding section repeats “shard by bucket ID” for two purported alternatives, then selects a bucket/object hash.
   This appears to be a wording error. Either way, scatter/gather plus per-shard offsets is not a snapshot pagination contract.
9. A checksum only detects corruption when it is independently recomputed and compared with trusted metadata. It does not repair
   bytes, prove fault independence, or constitute backup/restore evidence.
10. The chapter says a multipart part ETag is an MD5 checksum. Current AWS documentation supports several checksum algorithms and
    says the completed multipart ETag is not necessarily MD5. v0.1 calls its SHA-256 value a digest, not an S3 ETag.
11. Amazon S3 permits a later upload with the same part number to overwrite the previous part. v0.1 deliberately rejects changed
    bytes for an existing part number so response-loss replay and completion input stay unambiguous; it therefore makes no S3 API
    compatibility claim.
12. Copying live records during compaction and then changing mappings needs a generation fence and a rule for concurrent writes,
    reads, deletes, repair, and rollback. v0.1 does not implement packed-file compaction.

### Important omissions

- stable request identity, canonical intent digest, original-result replay, and changed-intent conflict;
- metadata/data non-atomicity, response loss after commit, orphan adoption, retention, and bounded GC;
- file and parent-directory fsync semantics, atomic rename scope, full readback digest, and same-host caveats;
- immutable version manifests, current-pointer preconditions, replica/placement generations, and stale repair fencing;
- current tombstone versus explicit old-version access versus physical reclamation;
- multipart expiry/abort races, immutable completion result, exact part sequence, total length/digest, and retry horizon;
- snapshot-stable listing and continuation bound to one query result;
- range validation and whole-object integrity binding;
- privacy-bounded metrics/logs, path traversal isolation, storage/backpressure limits, and low-cardinality errors;
- backup/restore, multi-region authority, RPO/RTO, legal erasure, client consumption, and external acceptance receipts.

## Primary calibration sources

### Amazon S3 overview and consistency model

- Official page: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html>
- Receipt: `tf_a7319d8a0367d7af_20260819T015353Z`
- SHA-256: `a7319d8a0367d7afd902126e8e7e68e660171da30a8642474aab76ad264de969`
- Applied decision: AWS documents strong read-after-write behavior for S3 object PUT/overwrite/DELETE and atomic single-key updates.
  It also describes multiple bucket types and namespace modes. These calibrate terminology only; the lab is not S3 and claims no
  cross-region/provider consistency.

### Amazon S3 versioning and delete markers

- Official pages: [Versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html) and [delete markers](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeleteMarker.html)
- Receipts: `tf_0eef1182fc35c64a_20260819T015353Z`, `tf_0dde5cbdd51de744_20260819T015353Z`
- SHA-256: `0eef1182fc35c64aba32ccc071588cd726d37f5d2ccc639003116f4a6a89908b`,
  `0dde5cbdd51de74453eed089c49638b8a02fcaa68a53d9a3f5f56a3a1e9edaa4`
- Applied decision: overwrite can create a new version and an unqualified delete can make a data-less current delete marker while
  older versions remain. v0.1 adopts that conceptual separation but keeps versioning always on and does not claim provider parity.

### Amazon S3 multipart uploads and checksums

- Official pages: [multipart overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html) and [object integrity](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html)
- Receipts: `tf_db407c50923af445_20260819T015353Z`, `tf_6dc12f8432219a7b_20260819T015353Z`
- SHA-256: `db407c50923af445c5de9e8a9c9a3de7fa9d938afab87712419467bb1b7f19d6`,
  `6dc12f8432219a7b2ba51ce177a14d5fc5a16f1e79cd9da7a6a51d6891ae5c07`
- Applied decision: initiation, part upload, ordered completion, abort, and cleanup are separate operations. ETag is not a universal
  MD5 checksum. The lab uses explicit SHA-256 digests and a stricter immutable-part policy.

### Amazon S3 ListObjectsV2

- Official page: <https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html>
- Receipt: `tf_ac2a136bd5963e06_20260819T015501Z`
- SHA-256: `ac2a136bd5963e063677017b93c3724f1be48af22783546cdbf7771ca54768b2`
- Applied decision: used only to distinguish a provider continuation token/API from this lab's materialized snapshot ID and page
  offset. v0.1 is JSON-only and exposes no S3 XML or token compatibility.

### Linux `fsync(2)` and `rename(2)`

- Manual pages: [`fsync(2)`](https://man7.org/linux/man-pages/man2/fsync.2.html) and [`rename(2)`](https://man7.org/linux/man-pages/man2/rename.2.html)
- Receipts: `tf_9e1ee7b3bc043cd7_20260819T015402Z`, `tf_3000f42bc38afdd0_20260819T015402Z`
- SHA-256: `9e1ee7b3bc043cd73e2cf22966a78ccfdd6f157ea3670f920bbc9670245a8726`,
  `3000f42bc38afdd0abe547544772311789a77e66825cd23f5b23d3237334d4ea`
- Applied decision: a successful file fsync does not necessarily persist its directory entry, while same-filesystem rename provides
  atomic name replacement. Linux CI therefore writes and fsyncs a temp file, renames within one directory, fsyncs that directory,
  then reopens and verifies length/digest. Hardware, controller, filesystem, host, and power-failure guarantees remain unproved.

### PostgreSQL 17 transaction isolation and explicit locking

- Official pages: [transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html) and [explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html)
- Receipts: `tf_70cf332f46ff2d05_20260819T015403Z`, `tf_dc13a9df72216e8b_20260819T015402Z`
- SHA-256: `70cf332f46ff2d0537fe7706a7922fee9f1d8092fe98a8ea05947fe7cc1c769d`,
  `dc13a9df72216e8bde3a9b6a4640493a6af8436c2ce7f06023bbce41e06cac44`
- Applied decision: short transactions and advisory/row locks serialize one request and logical key. LIST materializes one result
  in a Repeatable Read transaction instead of composing multiple Read Committed statements into a fictional snapshot.

### RFC 9110 — HTTP semantics

- Official page: <https://www.rfc-editor.org/rfc/rfc9110.html>
- Receipt: `tf_d431760660ea44e1_20260819T015403Z`
- SHA-256: `d431760660ea44e130f6e919dab216df2d0b3a490567a98089267523368fe1e5`
- Applied decision: `If-Match` is a strong-validator precondition used to prevent lost updates, and range requests are optional with
  distinct partial-response semantics. v0.1 applies equivalent explicit version preconditions and one bounded range in its JSON
  contract, but does not claim HTTP Range or ETag wire compatibility.

## Acquisition limitation

The direct TraceFetch attempt for the Node.js 22 filesystem API page returned `tracefetch_failed`. No retry or alternate unverified
copy is treated as evidence. The implementation relies on the acquired Linux manual semantics plus executable Node 22/24/26
filesystem tests; that validates the exercised calls, not every platform or device guarantee.

## Evidence boundary after calibration

The source review supports a bounded experiment in immutable manifests, same-host verified replicas, single-database visibility,
multipart completion, tombstones, snapshot listing, repair, orphan discovery, and fenced GC. It does not prove S3 compatibility,
cloud behavior, independent failure domains, erasure coding, consensus, multi-region consistency, disk/controller power-loss
durability, legal deletion, security/compliance, backup/restore, disaster recovery, production capacity, SLA, client consumption,
business outcome, or external acceptance.
