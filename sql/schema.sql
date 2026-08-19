DROP TABLE IF EXISTS gc_runs CASCADE;
DROP TABLE IF EXISTS orphan_scans CASCADE;
DROP TABLE IF EXISTS repair_tasks CASCADE;
DROP TABLE IF EXISTS list_snapshots CASCADE;
DROP TABLE IF EXISTS multipart_parts CASCADE;
DROP TABLE IF EXISTS multipart_uploads CASCADE;
DROP TABLE IF EXISTS object_heads CASCADE;
DROP TABLE IF EXISTS version_replicas CASCADE;
DROP TABLE IF EXISTS object_versions CASCADE;
DROP TABLE IF EXISTS replicas CASCADE;
DROP TABLE IF EXISTS write_intents CASCADE;
DROP TABLE IF EXISTS mutation_receipts CASCADE;
DROP TABLE IF EXISTS buckets CASCADE;
DROP TABLE IF EXISTS maintenance_generations CASCADE;
DROP SEQUENCE IF EXISTS object_version_sequence;

CREATE SEQUENCE object_version_sequence AS bigint;

CREATE TABLE maintenance_generations (
  kind text PRIMARY KEY CHECK (kind IN ('repair', 'gc')),
  generation bigint NOT NULL CHECK (generation > 0),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

INSERT INTO maintenance_generations (kind, generation) VALUES ('repair', 1), ('gc', 1);

CREATE TABLE buckets (
  principal text NOT NULL,
  bucket_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (principal, bucket_name)
);

CREATE TABLE mutation_receipts (
  principal text NOT NULL,
  request_key text NOT NULL,
  operation text NOT NULL,
  intent_digest char(64) NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (principal, request_key, operation)
);

CREATE TABLE write_intents (
  principal text NOT NULL,
  request_key text NOT NULL,
  operation text NOT NULL,
  intent_digest char(64) NOT NULL,
  content_digest char(64) NOT NULL,
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 65536),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (principal, request_key, operation)
);

CREATE TABLE replicas (
  content_digest char(64) NOT NULL,
  node_id text NOT NULL CHECK (node_id IN ('node-a', 'node-b', 'node-c')),
  placement_generation bigint NOT NULL CHECK (placement_generation > 0),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 65536),
  state text NOT NULL CHECK (state IN ('verified', 'missing', 'corrupt')),
  receipt_digest char(64),
  verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (content_digest, node_id, placement_generation)
);

CREATE TABLE object_versions (
  principal text NOT NULL,
  bucket_name text NOT NULL,
  object_key text NOT NULL,
  version_id text NOT NULL,
  version_sequence bigint NOT NULL DEFAULT nextval('object_version_sequence'),
  kind text NOT NULL CHECK (kind IN ('data', 'tombstone')),
  content_digest char(64),
  byte_length integer,
  placement_generation bigint NOT NULL CHECK (placement_generation > 0),
  required_replicas smallint NOT NULL CHECK (required_replicas BETWEEN 0 AND 3),
  result_digest char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (principal, bucket_name, object_key, version_id),
  UNIQUE (principal, version_id),
  UNIQUE (version_sequence),
  FOREIGN KEY (principal, bucket_name) REFERENCES buckets (principal, bucket_name),
  CHECK (
    (kind = 'data' AND content_digest IS NOT NULL AND byte_length BETWEEN 1 AND 65536 AND required_replicas > 0)
    OR (kind = 'tombstone' AND content_digest IS NULL AND byte_length IS NULL AND required_replicas = 0)
  )
);

CREATE TABLE version_replicas (
  principal text NOT NULL,
  bucket_name text NOT NULL,
  object_key text NOT NULL,
  version_id text NOT NULL,
  content_digest char(64) NOT NULL,
  node_id text NOT NULL,
  placement_generation bigint NOT NULL,
  PRIMARY KEY (principal, bucket_name, object_key, version_id, node_id),
  FOREIGN KEY (principal, bucket_name, object_key, version_id)
    REFERENCES object_versions (principal, bucket_name, object_key, version_id) ON DELETE CASCADE,
  FOREIGN KEY (content_digest, node_id, placement_generation)
    REFERENCES replicas (content_digest, node_id, placement_generation)
);

CREATE TABLE object_heads (
  principal text NOT NULL,
  bucket_name text NOT NULL,
  object_key text NOT NULL,
  version_id text NOT NULL,
  head_generation bigint NOT NULL CHECK (head_generation > 0),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (principal, bucket_name, object_key),
  FOREIGN KEY (principal, bucket_name, object_key, version_id)
    REFERENCES object_versions (principal, bucket_name, object_key, version_id)
);

CREATE TABLE multipart_uploads (
  principal text NOT NULL,
  upload_id text NOT NULL,
  bucket_name text NOT NULL,
  object_key text NOT NULL,
  expected_parts smallint NOT NULL CHECK (expected_parts BETWEEN 1 AND 4),
  placement_generation bigint NOT NULL CHECK (placement_generation > 0),
  state text NOT NULL CHECK (state IN ('open', 'completed', 'aborted', 'expired')),
  expires_at timestamptz NOT NULL,
  completed_version_id text,
  completion_intent_digest char(64),
  completion_result jsonb,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (principal, upload_id),
  FOREIGN KEY (principal, bucket_name) REFERENCES buckets (principal, bucket_name),
  CHECK (
    (state = 'completed') = (
      completed_version_id IS NOT NULL AND completion_intent_digest IS NOT NULL AND completion_result IS NOT NULL
    )
  )
);

CREATE TABLE multipart_parts (
  principal text NOT NULL,
  upload_id text NOT NULL,
  part_number smallint NOT NULL CHECK (part_number BETWEEN 1 AND 4),
  content_digest char(64) NOT NULL,
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 65536),
  content_spec jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (principal, upload_id, part_number),
  FOREIGN KEY (principal, upload_id) REFERENCES multipart_uploads (principal, upload_id) ON DELETE CASCADE
);

CREATE TABLE list_snapshots (
  principal text NOT NULL,
  snapshot_id text NOT NULL,
  bucket_name text NOT NULL,
  prefix text NOT NULL,
  include_tombstones boolean NOT NULL,
  items jsonb NOT NULL,
  item_count smallint NOT NULL CHECK (item_count BETWEEN 0 AND 256),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (principal, snapshot_id),
  FOREIGN KEY (principal, bucket_name) REFERENCES buckets (principal, bucket_name)
);

CREATE TABLE repair_tasks (
  principal text NOT NULL,
  task_id text NOT NULL,
  bucket_name text NOT NULL,
  object_key text NOT NULL,
  version_id text NOT NULL,
  content_digest char(64) NOT NULL,
  target_node_id text NOT NULL CHECK (target_node_id IN ('node-a', 'node-b', 'node-c')),
  placement_generation bigint NOT NULL,
  maintenance_generation bigint NOT NULL,
  observed_state text NOT NULL CHECK (observed_state IN ('missing', 'corrupt')),
  state text NOT NULL CHECK (state IN ('pending', 'repaired', 'superseded')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (principal, task_id),
  UNIQUE (principal, version_id, target_node_id, maintenance_generation),
  FOREIGN KEY (principal, bucket_name, object_key, version_id)
    REFERENCES object_versions (principal, bucket_name, object_key, version_id) ON DELETE CASCADE
);

CREATE TABLE orphan_scans (
  principal text NOT NULL,
  scan_id text NOT NULL,
  maintenance_generation bigint NOT NULL,
  minimum_age_ms integer NOT NULL CHECK (minimum_age_ms BETWEEN 0 AND 3600000),
  items jsonb NOT NULL,
  candidate_count integer NOT NULL CHECK (candidate_count >= 0),
  recent_count integer NOT NULL CHECK (recent_count >= 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (principal, scan_id)
);

CREATE TABLE gc_runs (
  principal text NOT NULL,
  run_id text NOT NULL,
  scan_id text NOT NULL,
  maintenance_generation bigint NOT NULL,
  deleted_count integer NOT NULL CHECK (deleted_count >= 0),
  kept_count integer NOT NULL CHECK (kept_count >= 0),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (principal, run_id),
  FOREIGN KEY (principal, scan_id) REFERENCES orphan_scans (principal, scan_id)
);

CREATE INDEX object_versions_key_sequence_idx
  ON object_versions (principal, bucket_name, object_key, version_sequence DESC);
CREATE INDEX write_intents_expiry_idx ON write_intents (expires_at);
CREATE INDEX repair_tasks_pending_idx ON repair_tasks (principal, state, created_at);
