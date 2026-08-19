import { Pool } from 'pg';
import { ObjectRepository } from '../src/repository.js';
import { ObjectStorageService } from '../src/service.js';
import { ReplicaStore } from '../src/storage.js';

export async function createRuntime({
  storageRoot,
  reset = false,
  nodeIds,
  writeIntentTtlMs,
  logger = () => {},
} = {}) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!storageRoot) throw new Error('storageRoot is required');
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const repository = new ObjectRepository(pool);
  if (reset) await repository.resetSchema();
  const replicaStore = new ReplicaStore(storageRoot, nodeIds ? { nodeIds } : undefined);
  const service = new ObjectStorageService({ repository, replicaStore, logger, writeIntentTtlMs });
  await service.initialize();
  return { pool, repository, replicaStore, service };
}
