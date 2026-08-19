import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

const root = new URL('..', import.meta.url);
const expected = [
  '.github/dependabot.yml',
  '.github/workflows/ci.yml',
  '.gitignore',
  '.node-version',
  'AGENTS.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'compose.yaml',
  'docs/adr/0001-postgres-metadata-and-content-addressed-replicas.md',
  'docs/api.md',
  'docs/architecture.md',
  'docs/closed-book-contract.md',
  'docs/operations.md',
  'docs/requirements.md',
  'docs/research-log.md',
  'docs/threat-model.md',
  'docs/verification.md',
  'package-lock.json',
  'package.json',
  'scripts/crash-worker.mjs',
  'scripts/infra-benchmark.mjs',
  'scripts/infra-smoke.mjs',
  'scripts/repo-check.mjs',
  'scripts/runtime.mjs',
  'sql/schema.sql',
  'src/contracts.js',
  'src/crypto.js',
  'src/errors.js',
  'src/http.js',
  'src/index.js',
  'src/main.js',
  'src/model.js',
  'src/repository.js',
  'src/service.js',
  'src/storage.js',
  'test/integration/postgresql.test.js',
  'test/unit/contracts.test.js',
  'test/unit/http.test.js',
  'test/unit/model.test.js',
  'test/unit/storage.test.js',
];

async function walk(directory, prefix = '') {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.tmp') continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...await walk(new URL(`${entry.name}/`, directory), relative));
    else paths.push(relative);
  }
  return paths;
}

for (const path of expected) {
  assert.equal((await stat(new URL(path, root))).isFile(), true, `missing required file: ${path}`);
}

const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
assert.equal(packageJson.private, true);
assert.equal(packageJson.engines.node, '>=22');
assert.deepEqual(packageJson.dependencies, { pg: '8.23.0' });
assert.equal(packageJson.repository.url, 'git+https://github.com/estelledc/system-design-24-object-storage.git');
for (const script of ['lint', 'test', 'test:infra', 'smoke:infra', 'benchmark:infra', 'audit', 'check', 'check:ci']) {
  assert.equal(typeof packageJson.scripts[script], 'string', `missing package script: ${script}`);
}
const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
assert.equal(lock.lockfileVersion, 3);
assert.deepEqual(lock.packages[''].dependencies, packageJson.dependencies);

const workflow = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');
assert.match(workflow, /node: \[22, 24, 26\]/);
assert.match(workflow, /PostgreSQL 17\.11 \+ real filesystem/);
assert.match(workflow, /postgres:17\.11-alpine@sha256:[0-9a-f]{64}/);
assert.match(workflow, /permissions:\n  contents: read/);
const actionUses = [...workflow.matchAll(/uses: [^@\n]+@([^\s#]+)/g)].map((match) => match[1]);
assert.ok(actionUses.length >= 2);
assert.ok(actionUses.every((reference) => /^[0-9a-f]{40}$/.test(reference)), 'actions must use full commit pins');

const compose = await readFile(new URL('compose.yaml', root), 'utf8');
assert.match(compose, /postgres:17\.11-alpine@sha256:[0-9a-f]{64}/);
assert.match(compose, /pg_isready -U postgres -d object_storage/);

const schema = await readFile(new URL('sql/schema.sql', root), 'utf8');
for (const contract of [
  'PRIMARY KEY (principal, request_key, operation)',
  "state IN ('verified', 'missing', 'corrupt')",
  "kind IN ('data', 'tombstone')",
  'FOREIGN KEY (content_digest, node_id, placement_generation)',
  "state IN ('open', 'completed', 'aborted', 'expired')",
  'completion_intent_digest char(64)',
  "kind IN ('repair', 'gc')",
]) assert.ok(schema.includes(contract), `missing schema contract: ${contract}`);

const repository = await readFile(new URL('src/repository.js', root), 'utf8');
for (const contract of [
  'pg_advisory_xact_lock',
  "WHERE kind = 'gc' FOR ${mode}",
  'write_intents',
  'statement_timestamp()',
  'intent_conflict',
]) assert.ok(repository.includes(contract), `missing repository contract: ${contract}`);

const storage = await readFile(new URL('src/storage.js', root), 'utf8');
for (const contract of [
  "await handle.sync()",
  'await rename(temporaryPath, finalPath)',
  'await syncDirectory(directory)',
  "state: 'corrupt'",
  'readbackVerified: true',
]) assert.ok(storage.includes(contract), `missing storage evidence boundary: ${contract}`);

const service = await readFile(new URL('src/service.js', root), 'utf8');
for (const boundary of [
  'OBJECT_CRASH_AFTER_FIRST_REPLICA',
  'OBJECT_CRASH_AFTER_PUT_COMMIT',
  'OBJECT_CRASH_AFTER_PART_COMMIT',
  'OBJECT_CRASH_AFTER_COMPLETE_COMMIT',
  'OBJECT_CRASH_AFTER_DELETE_COMMIT',
]) assert.ok(service.includes(boundary), `missing process crash boundary: ${boundary}`);
for (const contract of [
  "isolation: 'REPEATABLE READ'",
  'fullObjectDigestVerified: true',
  "state = 'completed'",
  'stale_generation',
  'lockGcReferences',
  'externalAcceptanceProved: false',
]) assert.ok(service.includes(contract), `missing service contract: ${contract}`);

const logSources = [service, await readFile(new URL('src/http.js', root), 'utf8')];
const logBodies = logSources.flatMap((source) => (
  [...source.matchAll(/(?:this\.)?logger\(\{([\s\S]*?)\}\)/g)].map((match) => match[1])
));
assert.ok(logBodies.length >= 10, 'expected explicit low-cardinality log sites');
for (const body of logBodies) {
  for (const forbiddenField of [
    'bucket', 'key', 'requestKey', 'versionId', 'uploadId', 'snapshotId', 'taskId', 'scanId',
    'contentDigest', 'intentDigest', 'body', 'authorization', 'apiToken', 'principal', 'path', 'nodeId',
  ]) assert.equal(new RegExp(`\\b${forbiddenField}\\s*:`).test(body), false, `ordinary log includes ${forbiddenField}`);
}

const research = await readFile(new URL('docs/research-log.md', root), 'utf8');
for (const pinned of [
  '9d8388721e7231442763ad37398b8d82224aa68f',
  '20ab041318a6b30006604c09e0510725fbe2427b',
  '33a21e49849769daef7214e298e1e3ca5e9389480a486de4f5434ef145052b96',
  'a7319d8a0367d7afd902126e8e7e68e660171da30a8642474aab76ad264de969',
  '0eef1182fc35c64aba32ccc071588cd726d37f5d2ccc639003116f4a6a89908b',
  '0dde5cbdd51de74453eed089c49638b8a02fcaa68a53d9a3f5f56a3a1e9edaa4',
  'db407c50923af445c5de9e8a9c9a3de7fa9d938afab87712419467bb1b7f19d6',
  '6dc12f8432219a7b2ba51ce177a14d5fc5a16f1e79cd9da7a6a51d6891ae5c07',
  'ac2a136bd5963e063677017b93c3724f1be48af22783546cdbf7771ca54768b2',
  '9e1ee7b3bc043cd73e2cf22966a78ccfdd6f157ea3670f920bbc9670245a8726',
  '3000f42bc38afdd0abe547544772311789a77e66825cd23f5b23d3237334d4ea',
  '70cf332f46ff2d0537fe7706a7922fee9f1d8092fe98a8ea05947fe7cc1c769d',
  'dc13a9df72216e8bde3a9b6a4640493a6af8436c2ce7f06023bbce41e06cac44',
  'd431760660ea44e130f6e919dab216df2d0b3a490567a98089267523368fe1e5',
  'tracefetch_failed',
]) assert.ok(research.includes(pinned), `research log is missing fixed evidence identity: ${pinned}`);

const integration = await readFile(new URL('test/integration/postgresql.test.js', root), 'utf8');
assert.match(integration, /Infrastructure tests never skip/);
assert.doesNotMatch(integration, /\.skip\s*\(/);
for (const state of ['intent_conflict', 'precondition_failed', 'current_tombstone', 'stale_generation', 'replica_threshold_not_met']) {
  assert.ok(integration.includes(state), `integration matrix misses ${state}`);
}
const smoke = await readFile(new URL('scripts/infra-smoke.mjs', root), 'utf8');
for (const boundary of ['FIRST_REPLICA', 'PUT_COMMIT', 'PART_COMMIT', 'COMPLETE_COMMIT', 'DELETE_COMMIT']) {
  assert.ok(smoke.includes(`OBJECT_CRASH_AFTER_${boundary}`));
}
assert.match(smoke, /killedProcesses\.length, 6/);
assert.match(smoke, /externalAcceptanceProved: false/);
const benchmark = await readFile(new URL('scripts/infra-benchmark.mjs', root), 'utf8');
for (const fixed of [
  'objects: 64',
  'objectBytes: 16_384',
  'fullReads: 64',
  'rangeReads: 64',
  'multipartParts: 4',
  'listSnapshots: 16',
]) assert.ok(benchmark.includes(fixed), `benchmark fixture is not fixed: ${fixed}`);

const files = await walk(root);
const portable = files.filter((path) => /\.(?:md|js|mjs|json|sql|ya?ml)$/.test(path));
const forbidden = [
  /\/Users\//,
  /\/private\/tmp\//,
  /file:\/\//,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  new RegExp(['Co', 'Authored-By:'].join('-')),
];
for (const path of portable) {
  const contents = await readFile(new URL(path, root), 'utf8');
  for (const pattern of forbidden) assert.equal(pattern.test(contents), false, `${path} contains forbidden portable data`);
}

for (const path of files.filter((value) => value.endsWith('.md'))) {
  const contents = await readFile(new URL(path, root), 'utf8');
  for (const match of contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split('#', 1)[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    const resolved = normalize(join(dirname(path), decodeURIComponent(target)));
    assert.equal((await stat(new URL(resolved, root))).isFile(), true, `${path} has broken link: ${target}`);
  }
}

for (const path of files.filter((value) => /\.(?:js|mjs)$/.test(value))) {
  execFileSync(process.execPath, ['--check', path], { cwd: root, stdio: 'inherit' });
}
execFileSync('git', ['diff', '--check'], { cwd: root, stdio: 'inherit' });
process.stdout.write(`${JSON.stringify({
  evidence: 'repository_policy_check',
  files: files.length,
  serviceLogSitesChecked: logBodies.length,
  markdownLinksChecked: true,
  syntaxChecked: true,
  sameHostOnly: true,
  externalAcceptanceProved: false,
})}\n`);
