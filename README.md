# S3-like Object Storage Lab

This clean-room system-design practice starts with one question: when object bytes are copied to several local storage-node
directories and metadata changes visibility, what receipts prove which bytes and object version are durable, readable, repairable,
or still orphaned after a crash?

The prompt title is “S3-like Object Storage.” This repository does not copy Amazon S3, a source chapter, API implementation,
diagram, object, bucket/key list, benchmark, or proprietary behavior. The initial contract is frozen from the title alone before
reading the fixed secondary chapter.

## Current phase

Closed-book contract only. Source comparison, standards/vendor review, storage/metadata choice, implementation, tests, benchmark,
public remote, CI, deployment, durability, SLA, backup/restore, and external acceptance are pending.

Candidate concerns include immutable object versions, content digests, verified replica receipts, atomic visibility, stable retries,
multipart completion, range reads, tombstones, snapshot listing, repair, orphan reclamation, GC fencing, and privacy-bounded
observability. They remain hypotheses until source review and executable validation.

## Read first

- [Closed-book contract](docs/closed-book-contract.md)
- [Security policy](SECURITY.md)

## Evidence boundary

Input accepted, bytes written, file flushed, directory entry durable, replica readback verified, metadata version committed, key
visible, GET digest verified, replica repaired, backup complete, restore tested, client consumed, and external acceptance are
different facts. This lab will name and test only the boundaries it reaches.

## License

MIT. Third-party study material and real object, account, cloud, identity, credential, endpoint, or internal data are not included.
