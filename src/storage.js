import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { NODE_IDS } from './contracts.js';
import { sha256, digestObject } from './crypto.js';
import { fail } from './errors.js';

const DIGEST = /^[a-f0-9]{64}$/;
const TEMP = /^\.tmp-[a-f0-9]{64}-[0-9]+-[a-f0-9-]{36}$/;

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class ReplicaStore {
  constructor(root, { nodeIds = NODE_IDS } = {}) {
    if (typeof root !== 'string' || root.length === 0) fail('invalid_input', 'storage root is required');
    if (!Array.isArray(nodeIds) || nodeIds.some((node) => !NODE_IDS.includes(node))) {
      fail('invalid_input', 'storage node set is invalid');
    }
    this.root = resolve(root);
    this.nodeIds = [...nodeIds];
  }

  objectsDirectory(nodeId) {
    if (!NODE_IDS.includes(nodeId)) fail('invalid_input', 'node is invalid');
    const directory = resolve(this.root, nodeId, 'objects');
    if (!directory.startsWith(`${this.root}${sep}`)) fail('invalid_input', 'storage path escaped root');
    return directory;
  }

  finalPath(nodeId, digest) {
    if (!DIGEST.test(digest)) fail('invalid_input', 'content digest is invalid');
    return join(this.objectsDirectory(nodeId), `${digest}.blob`);
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
    for (const nodeId of NODE_IDS) await mkdir(this.objectsDirectory(nodeId), { recursive: true });
  }

  async verify(nodeId, digest, { includeBytes = false } = {}) {
    try {
      const bytes = await readFile(this.finalPath(nodeId, digest));
      const actualDigest = sha256(bytes);
      if (actualDigest !== digest) return { state: 'corrupt', nodeId, byteLength: bytes.length };
      return {
        state: 'verified',
        nodeId,
        byteLength: bytes.length,
        contentDigest: digest,
        ...(includeBytes ? { bytes } : {}),
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: 'missing', nodeId, byteLength: null };
      throw error;
    }
  }

  async publish(nodeId, bytes, digest) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) fail('invalid_input', 'replica bytes are required');
    if (sha256(bytes) !== digest) fail('integrity_failure', 'provided bytes do not match digest', 503);
    await this.initialize();

    const existing = await this.verify(nodeId, digest);
    if (existing.state === 'verified' && existing.byteLength === bytes.length) {
      const existingHandle = await open(this.finalPath(nodeId, digest), 'r');
      try {
        await existingHandle.sync();
      } finally {
        await existingHandle.close();
      }
      await syncDirectory(this.objectsDirectory(nodeId));
      const readback = await this.verify(nodeId, digest);
      if (readback.state !== 'verified' || readback.byteLength !== bytes.length) {
        fail('integrity_failure', 'adopted replica verification failed', 503);
      }
      const receipt = {
        nodeId,
        contentDigest: digest,
        byteLength: bytes.length,
        fileSynced: true,
        directorySynced: true,
        readbackVerified: true,
        adopted: true,
      };
      return { ...receipt, receiptDigest: digestObject(receipt) };
    }

    const directory = this.objectsDirectory(nodeId);
    const temporaryName = `.tmp-${digest}-${process.pid}-${randomUUID()}`;
    const temporaryPath = join(directory, temporaryName);
    const finalPath = this.finalPath(nodeId, digest);
    let handle;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, finalPath);
      await syncDirectory(directory);
      const readback = await this.verify(nodeId, digest);
      if (readback.state !== 'verified' || readback.byteLength !== bytes.length) {
        fail('integrity_failure', 'replica readback verification failed', 503);
      }
      const receipt = {
        nodeId,
        contentDigest: digest,
        byteLength: bytes.length,
        fileSynced: true,
        directorySynced: true,
        readbackVerified: true,
        adopted: false,
      };
      return { ...receipt, receiptDigest: digestObject(receipt) };
    } finally {
      if (handle) await handle.close().catch(() => {});
      await unlink(temporaryPath).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
  }

  async listEntries() {
    await this.initialize();
    const entries = [];
    for (const nodeId of NODE_IDS) {
      const directory = this.objectsDirectory(nodeId);
      for (const entryName of await readdir(directory)) {
        const blob = /^([a-f0-9]{64})\.blob$/.exec(entryName);
        if (!blob && !TEMP.test(entryName)) continue;
        const details = await stat(join(directory, entryName));
        if (!details.isFile()) continue;
        entries.push({
          nodeId,
          entryName,
          kind: blob ? 'blob' : 'temporary',
          digest: blob?.[1] ?? null,
          mtimeMs: Math.trunc(details.mtimeMs),
          byteLength: details.size,
        });
      }
    }
    return entries;
  }

  async deleteEntry(nodeId, entryName) {
    const blob = /^([a-f0-9]{64})\.blob$/.test(entryName);
    if (!blob && !TEMP.test(entryName)) fail('invalid_input', 'storage entry is invalid');
    const directory = this.objectsDirectory(nodeId);
    await unlink(join(directory, entryName));
    await syncDirectory(directory);
    return { deleted: true, directorySynced: true };
  }

  async corruptForTest(nodeId, digest, replacement = Buffer.from('synthetic-corruption')) {
    await writeFile(this.finalPath(nodeId, digest), replacement, { mode: 0o600 });
    const handle = await open(this.finalPath(nodeId, digest), 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(this.objectsDirectory(nodeId));
  }
}
