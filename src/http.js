import { createServer } from 'node:http';
import { constantTimeTextEqual } from './crypto.js';
import { DomainError, fail } from './errors.js';

const MAX_BODY_BYTES = 32_768;

async function jsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) fail('capacity_exceeded', 'request body is too large', 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('invalid_input', 'request body must be valid JSON');
  }
}

function send(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function authorizationToken(request) {
  const header = request.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
}

export function createObjectHttpServer({ service, apiToken, logger = () => {} }) {
  if (typeof apiToken !== 'string' || apiToken.length < 16) fail('invalid_input', 'OBJECT_API_TOKEN must have at least 16 characters');

  return createServer(async (request, response) => {
    let routeClass = 'unknown';
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') {
        routeClass = 'health';
        send(response, 200, { status: 'ok', authorityReachabilityProved: false });
        return;
      }
      if (!constantTimeTextEqual(authorizationToken(request), apiToken)) {
        fail('unauthorized', 'authentication failed', 401);
      }

      let result;
      if (request.method === 'POST' && url.pathname === '/v1/buckets') {
        routeClass = 'bucket_mutation';
        result = await service.createBucket(await jsonBody(request));
      } else if (request.method === 'PUT' && url.pathname === '/v1/objects') {
        routeClass = 'object_mutation';
        result = await service.putObject(await jsonBody(request));
      } else if (request.method === 'POST' && url.pathname === '/v1/object-reads') {
        routeClass = 'object_read';
        result = await service.readObject(await jsonBody(request));
      } else if (request.method === 'DELETE' && url.pathname === '/v1/objects') {
        routeClass = 'object_mutation';
        result = await service.deleteObject(await jsonBody(request));
      } else if (request.method === 'POST' && url.pathname === '/v1/list-snapshots') {
        routeClass = 'list_snapshot';
        result = await service.createListSnapshot(await jsonBody(request));
      } else if (request.method === 'GET' && /^\/v1\/list-snapshots\/[^/]+$/.test(url.pathname)) {
        routeClass = 'list_page';
        result = await service.getListPage({
          snapshotId: decodeURIComponent(url.pathname.split('/').at(-1)),
          offset: Number(url.searchParams.get('offset')),
          limit: Number(url.searchParams.get('limit')),
        });
      } else if (request.method === 'POST' && url.pathname === '/v1/multipart-uploads') {
        routeClass = 'multipart_mutation';
        result = await service.initiateMultipart(await jsonBody(request));
      } else if (request.method === 'PUT' && url.pathname === '/v1/multipart-parts') {
        routeClass = 'multipart_mutation';
        result = await service.putMultipartPart(await jsonBody(request));
      } else if (request.method === 'POST' && url.pathname === '/v1/multipart-completions') {
        routeClass = 'multipart_mutation';
        result = await service.completeMultipart(await jsonBody(request));
      } else if (request.method === 'POST' && url.pathname === '/v1/multipart-aborts') {
        routeClass = 'multipart_mutation';
        result = await service.abortMultipart(await jsonBody(request));
      } else if (request.method === 'POST' && url.pathname === '/v1/repairs') {
        routeClass = 'maintenance';
        result = await service.repair(await jsonBody(request));
      } else if (request.method === 'POST' && url.pathname === '/v1/orphan-scans') {
        routeClass = 'maintenance';
        result = await service.scanOrphans(await jsonBody(request));
      } else if (request.method === 'POST' && url.pathname === '/v1/gc-runs') {
        routeClass = 'maintenance';
        result = await service.garbageCollect(await jsonBody(request));
      } else if (request.method === 'POST' && url.pathname === '/v1/maintenance-generations') {
        routeClass = 'maintenance';
        result = await service.advanceMaintenanceGeneration(await jsonBody(request));
      } else if (request.method === 'GET' && url.pathname === '/v1/state') {
        routeClass = 'state';
        result = await service.state();
      } else {
        fail('not_found', 'route was not found', 404);
      }
      logger({ event: 'http_request', outcome: 'success', status: 200, method: request.method, routeClass });
      send(response, 200, result);
    } catch (error) {
      const known = error instanceof DomainError;
      const status = known ? error.status : 500;
      const code = known ? error.code : 'internal_error';
      const message = known ? error.message : 'internal error';
      logger({ event: 'http_request', outcome: code, status, method: request.method, routeClass });
      send(response, status, { error: { code, message } });
    }
  });
}
