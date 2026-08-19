import assert from 'node:assert/strict';
import test from 'node:test';
import { createObjectHttpServer } from '../../src/http.js';

const token = 'synthetic-http-token-0001';

async function withServer(service, callback) {
  const logs = [];
  const server = createObjectHttpServer({ service, apiToken: token, logger: (event) => logs.push(event) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    return await callback(`http://127.0.0.1:${address.port}`, logs);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('HTTP authentication fails closed and structured logs omit body identities', async () => {
  const service = {
    createBucket: async (body) => ({ bucket: body.bucket, metadataCommitted: true }),
  };
  await withServer(service, async (baseUrl, logs) => {
    const denied = await fetch(`${baseUrl}/v1/buckets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestKey: 'req_secret_001', bucket: 'private-bucket' }),
    });
    assert.equal(denied.status, 401);
    const accepted = await fetch(`${baseUrl}/v1/buckets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requestKey: 'req_secret_001', bucket: 'private-bucket' }),
    });
    assert.equal(accepted.status, 200);
    const serialized = JSON.stringify(logs);
    assert.doesNotMatch(serialized, /private-bucket|req_secret_001|synthetic-http-token/);
  });
});

test('HTTP maps typed domain errors and does not expose internals', async () => {
  const service = {
    readObject: async () => {
      const error = new Error('selected version is a tombstone');
      error.name = 'DomainError';
      error.code = 'current_tombstone';
      error.status = 404;
      throw error;
    },
  };
  await withServer(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/object-reads`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ bucket: 'lab-bucket', key: 'key-one' }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: { code: 'internal_error', message: 'internal error' } });
  });
});
