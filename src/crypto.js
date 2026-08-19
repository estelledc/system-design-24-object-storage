import { createHash, timingSafeEqual } from 'node:crypto';

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalized(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(normalized(value));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function digestObject(value) {
  return sha256(canonicalJson(value));
}

export function deterministicId(prefix, value, length = 24) {
  return `${prefix}_${sha256(typeof value === 'string' ? value : canonicalJson(value)).slice(0, length)}`;
}

export function constantTimeTextEqual(left, right) {
  const leftDigest = Buffer.from(sha256(String(left)));
  const rightDigest = Buffer.from(sha256(String(right)));
  return timingSafeEqual(leftDigest, rightDigest);
}
