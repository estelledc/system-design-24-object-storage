import { fail } from './errors.js';

export const NODE_IDS = Object.freeze(['node-a', 'node-b', 'node-c']);
export const PLACEMENT_GENERATION = 1;
export const REQUIRED_REPLICAS = 2;
export const MAX_BYTES = 65_536;
export const MAX_LIST_ITEMS = 256;

const BLOCKS = Object.freeze({
  alpha: 'alpha-0000-datum',
  beta: 'beta_-0000-datum',
  gamma: 'gamma-0000-datum',
  delta: 'delta-0000-datum',
});

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function expectRecord(value, label = 'body') {
  if (!isRecord(value)) fail('invalid_input', `${label} must be an object`);
  return value;
}

export function exactKeys(value, allowed, required = allowed) {
  expectRecord(value);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('invalid_input', `unsupported field: ${key}`);
  }
  for (const key of required) {
    if (!(key in value)) fail('invalid_input', `missing field: ${key}`);
  }
  return value;
}

function boundedText(value, label, pattern, maxLength) {
  if (typeof value !== 'string' || value.length > maxLength || !pattern.test(value)) {
    fail('invalid_input', `${label} has invalid format`);
  }
  return value;
}

export function requestKey(value) {
  return boundedText(value, 'requestKey', /^[a-z][a-z0-9_-]{2,63}$/, 64);
}

export function entityId(value, label) {
  return boundedText(value, label, /^[a-z][a-z0-9_-]{2,63}$/, 64);
}

export function bucketName(value) {
  return boundedText(value, 'bucket', /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/, 32);
}

export function objectKey(value, { allowEmpty = false } = {}) {
  if (allowEmpty && value === '') return value;
  boundedText(value, 'key', /^[A-Za-z0-9][A-Za-z0-9/_-]{0,95}$/, 96);
  if (value.includes('//') || value.split('/').some((part) => part === '.' || part === '..')) {
    fail('invalid_input', 'key has invalid segments');
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('invalid_input', `${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function generatedContent(value) {
  exactKeys(expectRecord(value, 'content'), ['pattern', 'repeat', 'variant'], ['pattern', 'repeat']);
  if (!Object.hasOwn(BLOCKS, value.pattern)) fail('invalid_input', 'content.pattern is unsupported');
  const repeat = boundedInteger(value.repeat, 'content.repeat', 1, 4_096);
  const variant = value.variant === undefined ? 0 : boundedInteger(value.variant, 'content.variant', 0, 65_535);
  const marker = variant.toString(16).padStart(4, '0');
  const block = BLOCKS[value.pattern].replace('0000', marker);
  const bytes = Buffer.from(block.repeat(repeat), 'ascii');
  if (bytes.length > MAX_BYTES) fail('capacity_exceeded', 'generated content exceeds 65536 bytes', 413);
  return { spec: { pattern: value.pattern, repeat, variant }, bytes };
}

export function currentVersionPrecondition(value) {
  if (value === undefined || value === null) return null;
  if (value === 'absent') return value;
  return boundedText(value, 'ifCurrentVersionId', /^ver_[a-f0-9]{24}$/, 28);
}

export function versionId(value) {
  if (value === undefined || value === null) return null;
  return boundedText(value, 'versionId', /^ver_[a-f0-9]{24}$/, 28);
}

export function uploadId(value) {
  return boundedText(value, 'uploadId', /^upl_[a-f0-9]{24}$/, 28);
}

export function snapshotId(value) {
  return boundedText(value, 'snapshotId', /^lst_[a-f0-9]{24}$/, 28);
}

export function taskId(value) {
  return boundedText(value, 'taskId', /^rpr_[a-f0-9]{24}$/, 28);
}

export function scanId(value) {
  return boundedText(value, 'scanId', /^scn_[a-f0-9]{24}$/, 28);
}

export function expectedParts(value) {
  return boundedInteger(value, 'expectedParts', 1, 4);
}

export function partNumber(value) {
  return boundedInteger(value, 'partNumber', 1, 4);
}

export function partSequence(value, count) {
  if (!Array.isArray(value) || value.length !== count) fail('parts_incomplete', 'parts must match the expected count', 409);
  const parsed = value.map(partNumber);
  if (parsed.some((number, index) => number !== index + 1)) {
    fail('parts_incomplete', 'parts must be exactly consecutive from 1', 409);
  }
  return parsed;
}

export function expiryMs(value) {
  return boundedInteger(value, 'expiresInMs', 100, 3_600_000);
}

export function generation(value, label = 'generation') {
  return boundedInteger(value, label, 1, Number.MAX_SAFE_INTEGER);
}

export function minimumAgeMs(value) {
  return boundedInteger(value, 'minimumAgeMs', 0, 3_600_000);
}

export function pageLimit(value) {
  return boundedInteger(value, 'limit', 1, 32);
}

export function pageOffset(value) {
  return boundedInteger(value, 'offset', 0, MAX_LIST_ITEMS);
}

export function byteRange(value, length) {
  if (value === undefined || value === null) return null;
  exactKeys(expectRecord(value, 'range'), ['start', 'endExclusive']);
  const start = boundedInteger(value.start, 'range.start', 0, Math.max(0, length - 1));
  const endExclusive = boundedInteger(value.endExclusive, 'range.endExclusive', 1, length);
  if (endExclusive <= start) fail('invalid_input', 'range must be non-empty');
  return { start, endExclusive };
}

export function includeTombstones(value) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') fail('invalid_input', 'includeTombstones must be boolean');
  return value;
}

export function safeOperation(value) {
  return boundedText(value, 'operation', /^[a-z][a-z0-9_:-]{2,95}$/, 96);
}
