# Threat model and privacy boundary

## Protected assets

- bearer token and authenticated principal;
- synthetic bucket names and object keys;
- generated object/part bytes and content digests;
- request, version, upload, snapshot, repair, scan, and worker identities;
- PostgreSQL rows, local storage paths, node layout, and raw error details;
- integrity/visibility decisions and mutation receipts.

The fixture contains no real user or company data, but the implementation treats identities and bytes as sensitive so the design
does not normalize unsafe logging habits.

## In-scope threats and controls

| Threat | Control |
|---|---|
| unauthenticated mutation/read | constant-time bearer-token comparison and fail-closed startup |
| request replay with changed body | canonical intent digest plus immutable receipt conflict |
| path traversal through key/digest | raw keys never form paths; digest grammar and configured-root containment |
| oversized body/part/list | byte/cardinality caps before allocation or database work |
| partial or corrupt file served | temp publication, sync/rename, full length/SHA-256 readback on write and read |
| metadata visible before bytes | verified replica threshold checked before one metadata transaction |
| response loss creates duplicate version | deterministic identity and stored original result |
| lost concurrent update | explicit current-version precondition and key advisory lock |
| multipart part substitution | immutable `(upload, part number)` digest and completion manifest |
| completion versus abort/expiry | upload row lock and terminal state transition |
| stale repair deletes/overwrites | placement and maintenance generation recheck |
| GC races a new reference | fresh database reachability check immediately before bounded delete |
| poisoned log/metric labels | low-cardinality event vocabulary; no raw identifiers, paths, content, or errors |
| secret/host leakage in repository | policy scan for credentials and absolute paths; synthetic values only |

## Deliberate abstentions

- The token is one lab secret, not tenant IAM, policy evaluation, signing, rotation, or revocation.
- SHA-256 provides accidental-corruption/content-identity evidence here, not authorization, authenticity against a malicious writer,
  encryption, MAC, or digital signature.
- Same-host files do not resist host, filesystem, controller, power, operator, or privileged-process compromise.
- There is no TLS, public network, untrusted archive parser, malware scan, arbitrary content type, quota/billing, audit export,
  encryption at rest, KMS, legal hold, compliance, or secure deletion.
- PostgreSQL and filesystem access are trusted local dependencies; SQL injection is constrained through parameters, but database
  administrator and local-root threats are not solved.
- Timing side channels, denial of service beyond small bounds, supply-chain compromise, kernel/filesystem defects, and hardware
  falsification remain out of scope.

## Logging rule

Allowed ordinary fields include event name, outcome code, operation class, count, byte bucket, replica count, range-used boolean,
generation mismatch boolean, and duration. Forbidden fields include bucket, key, request/version/upload/snapshot/task/scan IDs,
content/intent digest, body, authorization, token, principal, database URL, SQL, node/path/hostname, and raw exception message.

Tests inspect every structured log call and repository text. That is a bounded static/executable check, not proof that every future
dependency or platform error is sanitized.
