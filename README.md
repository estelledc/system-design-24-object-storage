# S3-like Object Storage Lab

[![CI](https://github.com/estelledc/system-design-24-object-storage/actions/workflows/ci.yml/badge.svg)](https://github.com/estelledc/system-design-24-object-storage/actions/workflows/ci.yml)

This clean-room system-design practice starts with one question: when object bytes are copied to several local storage-node
directories and metadata changes visibility, what receipts prove which bytes and object version are durable, readable, repairable,
or still orphaned after a crash?

The prompt title is “S3-like Object Storage.” This repository does not copy Amazon S3, a source chapter, API implementation,
diagram, object, bucket/key list, benchmark, or proprietary behavior. The initial contract is frozen from the title alone before
reading the fixed secondary chapter.

## What is implemented

The closed-book contract is frozen at commit `76a87918dbed530b33c7a9231656961435433aa4`; the fixed secondary chapter and primary
sources were then compared without copying unlicensed material. v0.1 implements the selected invariant with:

- PostgreSQL 17 as bucket, immutable-version, current-pointer, request-receipt, multipart, list-snapshot, repair, and GC authority;
- three content-addressed directories on one host, with two verified copies required for visibility;
- temp write, file sync, rename, parent-directory sync, full SHA-256 readback, and re-sync before adopting an existing exact copy;
- an expiring non-visible write intent that protects the filesystem/metadata gap from concurrent GC;
- exact request replay, changed-intent conflict, version preconditions, tombstones, old-version reads, and full-integrity ranges;
- immutable multipart parts and exactly-once local completion—deliberately stricter than Amazon S3 part replacement semantics;
- materialized list snapshots, corruption fallback, generation-fenced repair, orphan scan, and retention-aware deletion;
- JSON HTTP on loopback with one synthetic bearer token and privacy-bounded logs.

This is not an S3 clone. It implements no XML, SigV4, provider ETag, cloud account, arbitrary upload, independent storage node,
consensus, erasure coding, backup/restore, multi-region behavior, durability percentage, availability SLA, or production capacity.

## Run the gates

Use a disposable PostgreSQL 17 database. `sql/schema.sql` drops and rebuilds this lab's tables.

```bash
npm ci --ignore-scripts
docker compose up -d postgres
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/object_storage
export OBJECT_API_TOKEN=local-synthetic-token-0001
npm run check:ci
```

`npm run check:ci` runs repository policy/syntax checks, nine pure tests, four real PostgreSQL/filesystem integration groups, six
true `SIGKILL` recovery cases, a real loopback HTTP state request, dependency audit, and the bounded benchmark. Infrastructure
tests fail rather than skip if PostgreSQL or filesystem behavior is unavailable.

The fixed benchmark writes 64 unique 16 KiB objects, performs 64 full and 64 range reads, completes one four-part 64 KiB object,
materializes 16 list snapshots, repairs one corrupt copy, and reclaims deliberately unreachable files. Its timings describe only
that exact runner and fixture.

## Read first

- [Closed-book contract](docs/closed-book-contract.md)
- [Source comparison](docs/research-log.md)
- [Requirements](docs/requirements.md)
- [Architecture](docs/architecture.md)
- [API contract](docs/api.md)
- [Operations](docs/operations.md)
- [Threat model](docs/threat-model.md)
- [Verification plan](docs/verification.md)
- [ADR: PostgreSQL metadata and content-addressed replicas](docs/adr/0001-postgres-metadata-and-content-addressed-replicas.md)
- [Security policy](SECURITY.md)

## Evidence boundary

Input accepted, bytes written, file flushed, directory entry durable, replica readback verified, metadata version committed, key
visible, GET digest verified, replica repaired, backup complete, restore tested, client consumed, and external acceptance are
different facts. This lab will name and test only the boundaries it reaches.

Current executable evidence proves only synchronous same-host file publication/readback, local PostgreSQL visibility/replay,
selected process-crash recovery, verified reads, one repair, and fenced local reclamation in the named fixture. A green CI job does
not prove power-loss behavior, independent failure domains, backup/restore, S3 compatibility, production readiness, client
consumption, or external acceptance.

## License

MIT. Third-party study material and real object, account, cloud, identity, credential, endpoint, or internal data are not included.
