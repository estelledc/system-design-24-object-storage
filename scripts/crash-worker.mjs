import { createRuntime } from './runtime.mjs';

async function main() {
  const action = process.argv[2];
  const input = JSON.parse(process.env.OBJECT_CRASH_INPUT ?? '{}');
  const storageRoot = process.env.OBJECT_STORAGE_ROOT;
  const runtime = await createRuntime({
    storageRoot,
    writeIntentTtlMs: Number(process.env.OBJECT_WRITE_INTENT_TTL_MS ?? 300_000),
  });
  try {
    if (action === 'put') await runtime.service.putObject(input);
    else if (action === 'part') await runtime.service.putMultipartPart(input);
    else if (action === 'complete') await runtime.service.completeMultipart(input);
    else if (action === 'delete') await runtime.service.deleteObject(input);
    else throw new Error('unknown crash action');
    process.stderr.write('crash boundary was not reached\n');
    process.exitCode = 2;
  } finally {
    await runtime.pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'crash worker failed'}\n`);
  process.exitCode = 1;
});
