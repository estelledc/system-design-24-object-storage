import { MAX_LIST_ITEMS } from './contracts.js';
import { fail } from './errors.js';

export function classifyOrphanEntries(entries, liveDigests, observedAtMs, minimumAgeMs) {
  const candidates = [];
  let recentCount = 0;
  for (const entry of entries) {
    if (entry.kind === 'blob' && liveDigests.has(entry.digest)) continue;
    if (observedAtMs - entry.mtimeMs < minimumAgeMs) {
      recentCount += 1;
      continue;
    }
    candidates.push(entry);
  }
  return { candidates, recentCount };
}

export function pageSnapshot(items, offset, limit) {
  if (!Array.isArray(items) || items.length > MAX_LIST_ITEMS) fail('capacity_exceeded', 'snapshot is invalid', 413);
  const page = items.slice(offset, offset + limit);
  return {
    items: page,
    nextOffset: offset + page.length < items.length ? offset + page.length : null,
  };
}
