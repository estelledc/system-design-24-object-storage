# Repository instructions

- This is an independent clean-room learning repository for one bounded object-storage invariant.
- Keep request validation, replica fsync/readback, metadata version commit, list visibility, verified GET, repair, backup, restore,
  client consumption, and external acceptance as separate facts.
- Never add real credentials, customer object keys/bytes, bucket names, cloud endpoints, account data, internal topology, or copied
  third-party prose, diagrams, fixtures, benchmarks, or code.
- Preserve unrelated work. Stage exact paths, keep commits single-purpose, and do not add co-author trailers unless requested.
- Durability conclusions require real filesystem/process/database boundaries in public CI; mocks cannot prove fsync, atomic rename,
  response-loss recovery, corruption detection, repair, tombstones, or garbage-collection fencing.
- A benchmark is a bounded synthetic observation for its exact fixture and runtime, never a durability, availability, throughput,
  latency, SLA, production-capacity, backup, or external-acceptance claim.
