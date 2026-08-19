# S3-like Object Storage Lab

This clean-room system-design practice starts with one question: when object bytes are copied to several local storage-node
directories and metadata changes visibility, what receipts prove which bytes and object version are durable, readable, repairable,
or still orphaned after a crash?

The prompt title is “S3-like Object Storage.” This repository does not copy Amazon S3, a source chapter, API implementation,
diagram, object, bucket/key list, benchmark, or proprietary behavior. The initial contract is frozen from the title alone before
reading the fixed secondary chapter.

## Current phase

Source-calibrated v0.1 design. The closed-book contract is frozen at commit
`76a87918dbed530b33c7a9231656961435433aa4`; the fixed secondary chapter and primary sources have now been compared without
copying unlicensed material. Implementation, executable verification, benchmark, public remote, and CI are pending.

The selected slice uses PostgreSQL as logical visibility authority and three content-addressed directories on one host. A replica
counts only after temp write, file sync, atomic rename, parent-directory sync, and full SHA-256 readback. Metadata requires two
verified copies, immutable versions, stable result replay, tombstones, exact multipart completion, snapshot listing, generation-
fenced repair, and retention-aware orphan GC.

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

## License

MIT. Third-party study material and real object, account, cloud, identity, credential, endpoint, or internal data are not included.
