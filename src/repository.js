import { readFile } from 'node:fs/promises';
import { DomainError, fail } from './errors.js';

export class ObjectRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async resetSchema() {
    const schema = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
    await this.pool.query(schema);
  }

  async transaction(callback, { isolation = 'READ COMMITTED' } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async lock(client, scope) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [scope]);
  }

  async lockGcReferences(client, mode = 'SHARE') {
    if (!['SHARE', 'UPDATE'].includes(mode)) throw new Error('invalid generation lock mode');
    const result = await client.query(`SELECT generation FROM maintenance_generations WHERE kind = 'gc' FOR ${mode}`);
    return Number(result.rows[0].generation);
  }

  async getReceipt(client, principal, requestKey, operation, intentDigest) {
    const result = await client.query(
      `SELECT intent_digest, result
         FROM mutation_receipts
        WHERE principal = $1 AND request_key = $2 AND operation = $3`,
      [principal, requestKey, operation],
    );
    if (result.rowCount === 0) return null;
    if (result.rows[0].intent_digest !== intentDigest) {
      fail('intent_conflict', 'request identity is already bound to different intent', 409);
    }
    return { ...result.rows[0].result, replayed: true };
  }

  async storeReceipt(client, principal, requestKey, operation, intentDigest, result) {
    await client.query(
      `INSERT INTO mutation_receipts (principal, request_key, operation, intent_digest, result)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [principal, requestKey, operation, intentDigest, JSON.stringify(result)],
    );
  }

  async reserveWriteIntent({ principal, requestKey, operation, intentDigest, contentDigest, byteLength, ttlMs }) {
    return this.transaction(async (client) => {
      await this.lock(client, `request:${principal}:${operation}:${requestKey}`);
      const receipt = await this.getReceipt(client, principal, requestKey, operation, intentDigest);
      if (receipt) return { replay: receipt };
      await this.lockGcReferences(client, 'SHARE');

      const existing = await client.query(
        `SELECT intent_digest, content_digest, byte_length
           FROM write_intents
          WHERE principal = $1 AND request_key = $2 AND operation = $3`,
        [principal, requestKey, operation],
      );
      if (existing.rowCount > 0) {
        const row = existing.rows[0];
        if (row.intent_digest !== intentDigest || row.content_digest !== contentDigest || Number(row.byte_length) !== byteLength) {
          fail('intent_conflict', 'write identity is already bound to different bytes', 409);
        }
        await client.query(
          `UPDATE write_intents
              SET expires_at = statement_timestamp() + ($4::bigint * interval '1 millisecond')
            WHERE principal = $1 AND request_key = $2 AND operation = $3`,
          [principal, requestKey, operation, ttlMs],
        );
      } else {
        await client.query(
          `INSERT INTO write_intents
             (principal, request_key, operation, intent_digest, content_digest, byte_length, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, statement_timestamp() + ($7::bigint * interval '1 millisecond'))`,
          [principal, requestKey, operation, intentDigest, contentDigest, byteLength, ttlMs],
        );
      }
      return { replay: null };
    });
  }

  async withMutation({ principal, requestKey, operation, intentDigest, isolation, callback }) {
    return this.transaction(async (client) => {
      await this.lock(client, `request:${principal}:${operation}:${requestKey}`);
      const replay = await this.getReceipt(client, principal, requestKey, operation, intentDigest);
      if (replay) return replay;
      const result = await callback(client);
      await this.storeReceipt(client, principal, requestKey, operation, intentDigest, result);
      return result;
    }, { isolation });
  }

  async replayMutation({ principal, requestKey, operation, intentDigest }) {
    return this.transaction(async (client) => {
      await this.lock(client, `request:${principal}:${operation}:${requestKey}`);
      return this.getReceipt(client, principal, requestKey, operation, intentDigest);
    });
  }

  async assertWriteIntent(client, principal, requestKey, operation, intentDigest, contentDigest) {
    const result = await client.query(
      `SELECT intent_digest, content_digest
         FROM write_intents
        WHERE principal = $1 AND request_key = $2 AND operation = $3
        FOR UPDATE`,
      [principal, requestKey, operation],
    );
    if (result.rowCount === 0) fail('internal_error', 'write intent is missing', 500);
    if (result.rows[0].intent_digest !== intentDigest || result.rows[0].content_digest !== contentDigest) {
      fail('intent_conflict', 'write intent changed', 409);
    }
  }

  async clearWriteIntent(client, principal, requestKey, operation) {
    await client.query(
      'DELETE FROM write_intents WHERE principal = $1 AND request_key = $2 AND operation = $3',
      [principal, requestKey, operation],
    );
  }

  static translateDatabaseError(error) {
    if (error instanceof DomainError) return error;
    if (error?.code === '23505') return new DomainError('intent_conflict', 'resource already exists', 409);
    return error;
  }
}
