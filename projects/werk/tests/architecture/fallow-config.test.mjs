import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { assertFallowReport } from '../../scripts/quality/report-contract.mjs';
import { generatedImportSource, verifyGeneratedImports } from '../../scripts/quality/generated-imports.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const binary = createRequire(import.meta.url).resolve('fallow/bin/fallow');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'werk-fallow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'node_modules'));
  const config = JSON.parse(await readFile(join(project, '.fallowrc.json'), 'utf8'));
  config.entry = ['src/worker/cli.ts', 'tests/**/*.test.{mjs,cjs}'];
  await put(root, '.fallowrc.json', JSON.stringify(config));
  await put(root, 'package.json', '{"name":"quality-fixture","private":true,"type":"module"}');
  await put(root, 'src/worker/cli.ts', "import { allowed } from '../shared/policy.js'; console.log(allowed);\n");
  await put(root, 'src/shared/policy.ts', 'export const allowed = true;\n');
  return root;
}
async function put(root, path, body) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), body); }
function run(root, args) {
  const result = spawnSync(process.execPath, [binary, '--root', root, '--config', join(root, '.fallowrc.json'), '--threads', '1', ...args, '--format', 'json'], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, FALLOW_TELEMETRY_DISABLED: '1', FALLOW_UPDATE_CHECK: 'off' },
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  return { status: result.status, report: JSON.parse(result.stdout) };
}

test('generated build mappings preserve app ownership and reject traversal, absolute and foreign paths', () => {
  const root = resolve('fixture-project'), importer = join(root, 'tests/worker/fixture.test.mjs');
  assert.equal(generatedImportSource(root, importer, '../../src/worker/dist/shared/errors.js'), 'src/shared/errors.ts');
  assert.equal(generatedImportSource(root, importer, '../../src/worker/dist/package.json'), 'package.json');
  assert.equal(generatedImportSource(root, importer, '../../src/worker/dist/worker/cli.js'), 'src/worker/cli.ts');
  for (const specifier of [
    '../../src/worker/dist/factory/cli.js', '../../src/worker/dist/worker/../shared/errors.js',
    '../../../outside/src/worker/dist/shared/errors.js', join(root, 'src/worker/dist/shared/errors.js'),
    '../../src/worker/dist/worker/webview/store.js', '../../src/worker/dist/shared/types.d.js',
    '../../src/worker/dist/shared/public/value.js', '../../src/worker/dist/shared/dist/value.js',
    '../../src/worker/dist/shared/node_modules/value.js', '../../src/worker/dist/shared/.build-42/value.js',
  ]) assert.throws(() => generatedImportSource(root, importer, specifier), undefined, specifier);
  assert.equal(generatedImportSource(root, join(root, 'worker.mjs'), './bin/apps/worker/scripts/runtime/portable/home.mjs'), 'scripts/runtime/portable/home.mjs');
  assert.throws(() => generatedImportSource(root, join(root, 'worker.mjs'), './bin/apps/worker/scripts/runtime/portable/missing.mjs'), /cannot traverse|does not match/);
  assert.equal(generatedImportSource(root, join(root, 'worker.mjs'), './runtime/bin/apps/worker/scripts/runtime/portable/home.mjs'), 'scripts/runtime/portable/home.mjs');
  for (const specifier of ['./runtime/bin/apps/worker/scripts/runtime/portable/missing.mjs', './runtime/bin/apps/factory/scripts/runtime/portable/home.mjs', './runtime/bin/apps/worker/scripts/runtime/portable/../portable/home.mjs']) assert.throws(() => generatedImportSource(root, join(root, 'worker.mjs'), specifier), /cannot traverse|does not match/);
  const mutationImporter = join(root, 'scripts/mutation/suites/fixture.test.mjs');
  assert.equal(generatedImportSource(root, mutationImporter, '../../../.mutation-build/shared/request-gate.js'), 'src/shared/request-gate.ts');
  assert.throws(() => generatedImportSource(root, mutationImporter, '../../../.mutation-build/worker/runner.js'), /configured mutation target/);
});

test('compiled import allowances still fail when the mapped source is missing', async t => {
  const root = await fixture(t);
  await put(root, 'tests/worker/fixture.test.mjs', "import '../../src/worker/dist/shared/policy.js';\n");
  assert.equal(await verifyGeneratedImports(root), 1);
  await put(root, 'tests/worker/fixture.test.mjs', "import '../../src/worker/dist/shared/misspelled.js';\n");
  await assert.rejects(verifyGeneratedImports(root), /misspelled/);
});

test('real Fallow accepts clean source without built artifacts and rejects cross-service imports', async t => {
  const root = await fixture(t);
  await put(root, 'tests/worker/fixture.test.mjs', "import '../../src/worker/dist/shared/policy.js';\n");
  assert.equal(await verifyGeneratedImports(root), 1);
  const clean = run(root, ['dead-code']);
  assert.equal(clean.status, 0);
  assertFallowReport(clean.report, 'dead-code');
  assertFallowReport(run(root, ['architecture', '--boundaries']).report, 'architecture');
  await put(root, 'src/factory/private.ts', 'export const secret = true;\n');
  await put(root, 'src/worker/cli.ts', "import { secret } from '../factory/private.js'; console.log(secret);\n");
  const result = run(root, ['architecture', '--boundaries']);
  assert.equal(result.status, 1);
  assert.equal(result.report.boundary_violations.length, 1);
});

test('exact Fallow baseline rejects new findings and stale accepted debt', async t => {
  const root = await fixture(t), baseline = join(root, 'baseline.json');
  await put(root, 'src/shared/old-debt.ts', 'export const previous = true;\n');
  assert.equal(run(root, ['dead-code', '--save-baseline', baseline]).status, 1);
  assert.equal(run(root, ['dead-code', '--baseline', baseline, '--fail-on-stale-baseline']).status, 0);
  await put(root, 'src/shared/new-debt.ts', 'export const regression = true;\n');
  const added = run(root, ['dead-code', '--baseline', baseline, '--fail-on-stale-baseline']);
  assert.equal(added.status, 1);
  assert.equal(added.report.unused_files.some(item => item.path === 'src/shared/new-debt.ts'), true);
  await rm(join(root, 'src/shared/new-debt.ts'));
  await rm(join(root, 'src/shared/old-debt.ts'));
  assert.equal(run(root, ['dead-code', '--baseline', baseline, '--fail-on-stale-baseline']).status, 1);
});

test('ordinary missing source imports are never covered by generated import allowances', async t => {
  const root = await fixture(t);
  await put(root, 'src/worker/cli.ts', "import './missing-source.js';\n");
  const result = run(root, ['dead-code']);
  assert.equal(result.status, 1);
  assert.equal(result.report.unresolved_imports.some(item => item.specifier === './missing-source.js'), true);
});

test('generated-import validation covers JSX, TSX and root entrypoints', async t => {
  for (const path of ['tests/worker/component.tsx', 'tests/worker/component.jsx', 'werk.mjs', 'worker.mjs', 'stryker.config.mjs']) {
    const root = await fixture(t);
    const prefix = path.includes('/') ? '../../' : './';
    await put(root, path, 'import "' + prefix + 'src/worker/dist/shared/missing.js";\n');
    await assert.rejects(verifyGeneratedImports(root), /missing/);
  }
});

test('malformed, incomplete and degraded Fallow reports cannot pass', async t => {
  const root = await fixture(t), valid = run(root, ['dead-code']).report;
  const changed = update => { const value = structuredClone(valid); update(value); return value; };
  const invalid = [
    {}, { ...valid, kind: 'architecture' }, { ...valid, version: '0.0.0' },
    { ...valid, total_issues: -1 }, { ...valid, summary: { total_issues: 0 } },
    changed(value => { value.unused_files.push({ path: 'hidden.ts' }); }),
    changed(value => { delete value.unresolved_imports; }),
    changed(value => { value.summary.unused_exports = 0.5; }),
    changed(value => { value.workspace_diagnostics = [{kind:'parse-error',message:'incomplete',degrades_analysis:true}]; }),
  ];
  for (const report of invalid) assert.throws(() => assertFallowReport(report, 'dead-code'));
});
