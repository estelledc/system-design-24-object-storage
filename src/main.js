import { resolve } from 'node:path';
import process from 'node:process';
import { Pool } from 'pg';
import { createObjectHttpServer } from './http.js';
import { ObjectRepository } from './repository.js';
import { ObjectStorageService } from './service.js';
import { ReplicaStore } from './storage.js';

function structuredLog(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function main() {
  if (process.argv[2] !== 'serve') throw new Error('usage: node src/main.js serve');
  const databaseUrl = process.env.DATABASE_URL;
  const apiToken = process.env.OBJECT_API_TOKEN;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!apiToken) throw new Error('OBJECT_API_TOKEN is required');
  const host = process.env.HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1') throw new Error('v0.1 server is restricted to loopback');
  const port = Number(process.env.PORT ?? 8787);
  const storageRoot = resolve(process.env.OBJECT_STORAGE_ROOT ?? '.tmp/object-storage');
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const repository = new ObjectRepository(pool);
  const replicaStore = new ReplicaStore(storageRoot);
  const service = new ObjectStorageService({ repository, replicaStore, logger: structuredLog });
  await service.initialize();
  await pool.query('SELECT 1');
  const server = createObjectHttpServer({ service, apiToken, logger: structuredLog });
  server.listen(port, host, () => structuredLog({ event: 'server_listen', outcome: 'ready', port }));

  const shutdown = () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'startup failed'}\n`);
  process.exitCode = 1;
});
